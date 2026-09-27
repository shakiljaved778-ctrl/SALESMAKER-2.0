import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRecord,
  deleteRecord,
  ownedRecordCount,
  purgeRecycleBin,
  readStored,
  RecordError,
  RECYCLE_DAYS,
  undeleteRecord,
} from '../src/index.js';
import { FULL, startHarness, type Harness } from './support.js';

const T = '01920000-0000-7000-8000-000000000d02';
let h: Harness;
const users: Record<string, string> = {};

beforeAll(async () => {
  h = await startHarness(T);
  await h.unit('sales');
  await h.unit('emea', 'sales');
  users['boss'] = await h.user('boss', 'sales');
  users['rep'] = await h.user('rep', 'emea');
  users['peer'] = await h.user('peer', 'emea');
  users['admin'] = await h.user('admin');
});

afterAll(async () => {
  await h.dispose();
});

type Grants = Parameters<Harness['context']>[2];
const ADMIN: Grants = { system: ['modify_all_data'] };
const as = <T>(
  user: string,
  fn: (
    tx: Parameters<Parameters<Harness['inTenant']>[0]>[0],
    ctx: Awaited<ReturnType<Harness['context']>>,
  ) => Promise<T>,
  grants?: Grants,
) => h.inTenant(async (tx) => fn(tx, await h.context(tx, users[user] ?? '', grants)));

const create = (user: string, object: string, fields: Record<string, unknown>) =>
  as(user, async (tx, ctx) => (await createRecord(tx, ctx, object, { fields })).id);
const remove = (user: string, object: string, id: string, grants?: Grants) =>
  as(user, (tx, ctx) => deleteRecord(tx, ctx, object, id), grants);
const restore = (user: string, object: string, id: string, grants?: Grants) =>
  as(user, (tx, ctx) => undeleteRecord(tx, ctx, object, id), grants);
const row = (object: string, id: string, includeDeleted = false) =>
  as('admin', (tx, ctx) => {
    const meta = ctx.metadata.object(object);
    if (!meta) throw new Error(object);
    return readStored(tx, meta, id, { includeDeleted });
  });
const bin = () =>
  h.inTenant((tx) => tx.prisma.recycleBinItem.findMany({ orderBy: { deletedAt: 'asc' } }));

async function refused(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    if (err instanceof RecordError)
      return { status: err.status, errors: err.errors.map((e) => `${e.field}:${e.code}`) };
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('deleteRecord (§7.5)', () => {
  it('moves an account to the bin with its contacts and opportunities', async () => {
    const account = await create('rep', 'account', { name: 'Pixelcraft' });
    const contact = await create('rep', 'contact', { last_name: 'Chen', account_id: account });
    const opp = await create('rep', 'opportunity', {
      name: 'Pixelcraft renewal',
      account_id: account,
      stage: 'qualification',
      close_date: '2026-12-01',
    });
    expect(await remove('rep', 'account', account)).toMatchObject({ cascaded: 2 });
    for (const [object, id] of [
      ['account', account],
      ['contact', contact],
      ['opportunity', opp],
    ] as const) {
      expect(await row(object, id)).toBeNull();
      expect((await row(object, id, true))?.deletedAt).not.toBeNull();
    }
    const items = await bin();
    const root = items.find((i) => i.recordId === account);
    expect(root).toMatchObject({ name: 'Pixelcraft', cascadeOf: null, deletedBy: users['rep'] });
    expect(root?.purgeAfter.getTime()).toBe(
      new Date('2026-09-27T10:00:00Z').getTime() + RECYCLE_DAYS * 86_400_000,
    );
    expect(
      items
        .filter((i) => i.cascadeOf === root?.id)
        .map((i) => i.recordId)
        .sort(),
    ).toEqual([contact, opp].sort());
    const events = await h.inTenant((tx) =>
      tx.prisma.outboxEvent.findMany({ where: { topic: 'automation.record_deleted' } }),
    );
    expect(events.map((e) => e.aggregateId)).toContain(account);
    const audits = await h.inTenant((tx) =>
      tx.prisma.auditLog.findMany({ where: { action: 'record.deleted', recordId: account } }),
    );
    expect(audits).toHaveLength(1);

    // A child that went with its parent comes back only with the parent.
    expect(await refused(restore('rep', 'contact', contact))).toEqual({
      status: 409,
      errors: ['_record:restore_parent'],
    });
    expect(await restore('rep', 'account', account)).toEqual({ restored: 3 });
    expect(await row('contact', contact)).not.toBeNull();
    expect(await row('opportunity', opp)).not.toBeNull();
    expect((await bin()).filter((i) => [account, contact, opp].includes(i.recordId))).toEqual([]);
  });

  it('needs Delete permission and Full access; a record out of sight is not found', async () => {
    const lead = await create('rep', 'lead', { last_name: 'Ng', company: 'Northwind' });
    // A peer cannot see the rep's lead at all.
    expect((await refused(remove('peer', 'lead', lead))).status).toBe(404);
    // With a read share they can see it, but only Full access deletes.
    await h.inTenant((tx) =>
      tx.prisma.recordShare.create({
        data: {
          tenantId: T,
          object: 'lead',
          recordId: lead,
          principalType: 'USER',
          principalId: users['peer'] ?? '',
          access: 2,
          reason: 'MANUAL',
        },
      }),
    );
    expect((await refused(remove('peer', 'lead', lead))).status).toBe(403);
    // Without the object's Delete permission even the owner cannot.
    const noDelete: Grants = { objects: { lead: { ...FULL, delete: false } } };
    expect((await refused(remove('rep', 'lead', lead, noDelete))).status).toBe(403);
    // Without Read on the object the record does not exist.
    const noRead: Grants = {
      objects: { lead: { ...FULL, read: false, create: false, edit: false, delete: false } },
    };
    expect((await refused(remove('rep', 'lead', lead, noRead))).status).toBe(404);
    // The owner's manager has Full access through the hierarchy.
    await remove('boss', 'lead', lead);
    expect(await row('lead', lead)).toBeNull();
    // Deleting again: gone.
    expect((await refused(remove('boss', 'lead', lead))).status).toBe(404);

    // Only whoever deleted it, or an admin, restores it.
    expect((await refused(restore('rep', 'lead', lead))).status).toBe(404);
    expect(await restore('admin', 'lead', lead, ADMIN)).toEqual({ restored: 1 });
    expect(await row('lead', lead)).not.toBeNull();
    expect((await refused(restore('admin', 'lead', lead, ADMIN))).status).toBe(404);
  });
});

describe('purgeRecycleBin', () => {
  it('hard-deletes what has expired with its shares and links, and clears lookups to it', async () => {
    const parent = await create('rep', 'account', { name: 'Globex' });
    const child = await create('rep', 'account', { name: 'Globex EU', parent_account_id: parent });
    const contact = await create('rep', 'contact', { last_name: 'Park', account_id: parent });
    await h.inTenant(async (tx) => {
      await tx.prisma.recordShare.create({
        data: {
          tenantId: T,
          object: 'account',
          recordId: parent,
          principalType: 'USER',
          principalId: users['peer'] ?? '',
          access: 1,
          reason: 'MANUAL',
        },
      });
      await tx.prisma.accountTeamMember.create({
        data: { tenantId: T, accountId: parent, userId: users['peer'] ?? '', role: 'Sales' },
      });
    });
    const kept = await create('rep', 'lead', { last_name: 'Kept', company: 'Kept' });
    await remove('rep', 'account', parent);
    await remove('rep', 'lead', kept);

    // Nothing is due yet.
    expect(
      await h.inTenant(async (tx) => {
        const ctx = await h.context(tx, users['admin'] ?? '');
        return purgeRecycleBin(tx, ctx.metadata, { now: new Date('2026-10-01T00:00:00Z') });
      }),
    ).toBe(0);
    const items = await bin();
    const due = items.filter((i) => [parent, contact].includes(i.recordId)).map((i) => i.id);
    const purged = await h.inTenant(async (tx) => {
      const ctx = await h.context(tx, users['admin'] ?? '');
      return purgeRecycleBin(tx, ctx.metadata, { ids: due });
    });
    expect(purged).toBe(2);
    expect(await row('account', parent, true)).toBeNull();
    expect(await row('contact', contact, true)).toBeNull();
    expect((await row('account', child))?.values['parent_account_id']).toBeNull();
    expect(await row('lead', kept, true)).not.toBeNull();
    const leftovers = await h.inTenant(async (tx) => ({
      shares: await tx.prisma.recordShare.count({ where: { recordId: parent } }),
      team: await tx.prisma.accountTeamMember.count({ where: { accountId: parent } }),
      items: await tx.prisma.recycleBinItem.count({ where: { id: { in: due } } }),
    }));
    expect(leftovers).toEqual({ shares: 0, team: 0, items: 0 });

    // Past the retention period the rest goes too.
    const later = new Date('2026-11-01T00:00:00Z');
    await h.inTenant(async (tx) => {
      const ctx = await h.context(tx, users['admin'] ?? '');
      await purgeRecycleBin(tx, ctx.metadata, { now: later });
    });
    expect(await row('lead', kept, true)).toBeNull();
  });

  it('counts what an owner still owns', async () => {
    const owner = await h.user('owner', 'emea');
    users['owner'] = owner;
    await create('owner', 'lead', { last_name: 'A', company: 'A' });
    await create('owner', 'account', { name: 'B' });
    expect(
      await h.inTenant(async (tx) =>
        ownedRecordCount(tx, (await h.context(tx, owner)).metadata, owner),
      ),
    ).toBe(2);
  });
});
