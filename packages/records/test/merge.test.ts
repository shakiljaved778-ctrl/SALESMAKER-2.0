import type { TenantTransaction } from '@sm/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRecord,
  mergeRecords,
  readStored,
  RecordError,
  type MergeInput,
  type RecordContext,
} from '../src/index.js';
import { FULL, startHarness, type Harness } from './support.js';

const T = '01920000-0000-7000-8000-000000000d0a';
let h: Harness;
const users: Record<string, string> = {};

beforeAll(async () => {
  h = await startHarness(T);
  await h.unit('sales');
  await h.unit('emea', 'sales');
  users['boss'] = await h.user('boss', 'sales');
  users['rep'] = await h.user('rep', 'emea');
  users['peer'] = await h.user('peer', 'emea');
});

afterAll(async () => {
  await h.dispose();
});

type Grants = Parameters<Harness['context']>[2];
const as = <R>(
  user: string,
  fn: (tx: TenantTransaction, ctx: RecordContext) => Promise<R>,
  grants?: Grants,
) => h.inTenant(async (tx) => fn(tx, await h.context(tx, users[user] ?? '', grants)));
const create = async (user: string, object: string, fields: Record<string, unknown>) =>
  (await as(user, (tx, ctx) => createRecord(tx, ctx, object, { fields }))).id;
const merge = (user: string, object: string, input: MergeInput, grants?: Grants) =>
  as(user, (tx, ctx) => mergeRecords(tx, ctx, object, input), grants);
const stored = (object: string, id: string) =>
  as(
    'boss',
    (tx, ctx) => {
      const meta = ctx.metadata.object(object);
      if (!meta) throw new Error(object);
      return readStored(tx, meta, id, { includeDeleted: true });
    },
    { system: ['modify_all_data'] },
  );
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
const count = (query: ReturnType<typeof sql<{ n: string }>>) =>
  h.inTenant(async (tx) => Number((await query.execute(tx.kysely)).rows[0]?.n));

describe('merge (§7.2)', () => {
  it('merges accounts: chosen fields win, children and links move, the others go to the bin', async () => {
    const master = await create('rep', 'account', { name: 'Gulf Trading', phone: '4400 1000' });
    const dup = await create('rep', 'account', {
      name: 'Gulf Trading WLL',
      website: 'https://gulf.example',
      industry: 'technology',
    });
    const dup2 = await create('rep', 'account', { name: 'Gulf Trading LLC' });
    const contact = await create('boss', 'contact', { last_name: 'Child', account_id: dup });
    const opp = await create('rep', 'opportunity', {
      name: 'Deal',
      account_id: dup2,
      close_date: '2026-12-01',
    });
    const child = await create('rep', 'account', { name: 'Subsidiary', parent_account_id: dup });
    // The survivor's own parent was one of the merged records: it would point at itself, so it clears.
    await as('rep', async (tx) =>
      sql`UPDATE account SET parent_account_id = ${dup}::uuid WHERE id = ${master}::uuid`.execute(
        tx.kysely,
      ),
    );
    await h.inTenant(async ({ prisma: p }) => {
      await p.accountTeamMember.createMany({
        data: [
          { tenantId: T, accountId: master, userId: users['boss'] ?? '', access: 1, role: 'a' },
          { tenantId: T, accountId: dup, userId: users['boss'] ?? '', access: 2, role: 'b' },
          { tenantId: T, accountId: dup, userId: users['peer'] ?? '', access: 1, role: 'c' },
        ],
      });
      await p.duplicateCandidate.create({
        data: {
          tenantId: T,
          object: 'account',
          recordIds: [master, dup].sort(),
          groupKey: [master, dup].sort().join(','),
          score: 1,
        },
      });
    });

    const result = await merge('rep', 'account', {
      masterId: master,
      duplicateIds: [dup, dup2],
      fields: { website: dup, industry: dup, name: master },
    });
    expect(result).toMatchObject({ id: master, merged: [dup, dup2] });

    const survivor = await stored('account', master);
    expect(survivor?.values).toMatchObject({
      name: 'Gulf Trading',
      phone: '4400 1000',
      website: 'https://gulf.example',
      industry: 'technology',
      parent_account_id: null,
    });
    expect((await stored('contact', contact))?.values['account_id']).toBe(master);
    expect((await stored('opportunity', opp))?.values['account_id']).toBe(master);
    expect((await stored('account', child))?.values['parent_account_id']).toBe(master);
    for (const id of [dup, dup2]) {
      const gone = await stored('account', id);
      expect(gone?.deletedAt).not.toBeNull();
      const merged = await h.inTenant(
        async (tx) =>
          (
            await sql<{
              m: string;
            }>`SELECT merged_into_id::text AS m FROM account WHERE id = ${id}::uuid`.execute(
              tx.kysely,
            )
          ).rows[0]?.m,
      );
      expect(merged).toBe(master);
    }
    // One team row per user: the survivor's own kept, peer's moved.
    const team = await h.inTenant(({ prisma: p }) =>
      p.accountTeamMember.findMany({ where: { accountId: master }, orderBy: { role: 'asc' } }),
    );
    expect(team.map((m) => [m.userId, m.role])).toEqual([
      [users['boss'], 'a'],
      [users['peer'], 'c'],
    ]);
    // The boss owns a contact under the survivor now: Read on it (implicit share).
    expect(
      await count(sql<{ n: string }>`SELECT count(*)::text AS n FROM record_share
        WHERE record_id = ${master}::uuid AND principal_id = ${users['boss'] ?? ''}::uuid
          AND reason = 'IMPLICIT_PARENT'`),
    ).toBe(1);
    const candidate = await h.inTenant(({ prisma: p }) =>
      p.duplicateCandidate.findFirstOrThrow({ where: { object: 'account' } }),
    );
    expect(candidate.status).toBe('MERGED');
    const history = await h.inTenant(({ prisma: p }) =>
      p.fieldHistory.findFirst({ where: { recordId: master, field: '_merged' } }),
    );
    expect(history?.newValue).toEqual([dup, dup2]);
    const audited = await h.inTenant(({ prisma: p }) =>
      p.auditLog.findFirstOrThrow({ where: { recordId: master, action: 'record.merged' } }),
    );
    expect(audited.payload).toMatchObject({
      merged: [dup, dup2],
      fields: ['website', 'industry'],
    });
  });

  it('merges contacts and leads with their link rows, never duplicating a link', async () => {
    const campaign = await create('rep', 'campaign', { name: 'Spring' });
    const a = await create('rep', 'lead', { last_name: 'Haddad', company: 'G' });
    const b = await create('rep', 'lead', {
      last_name: 'Hadad',
      company: 'G',
      email: 'h@g.example',
    });
    await h.inTenant(({ prisma: p }) =>
      p.campaignMember.createMany({
        data: [
          { tenantId: T, campaignId: campaign, leadId: a },
          { tenantId: T, campaignId: campaign, leadId: b },
        ],
      }),
    );
    await merge('rep', 'lead', { masterId: a, duplicateIds: [b], fields: { email: b } });
    expect((await stored('lead', a))?.values['email']).toBe('h@g.example');
    expect(
      await count(
        sql<{
          n: string;
        }>`SELECT count(*)::text AS n FROM campaign_member WHERE campaign_id = ${campaign}::uuid`,
      ),
    ).toBe(1);

    const account = await create('rep', 'account', { name: 'Roles' });
    const opp = await create('rep', 'opportunity', {
      name: 'R',
      account_id: account,
      close_date: '2026-12-01',
    });
    const c1 = await create('rep', 'contact', { last_name: 'One', account_id: account });
    const c2 = await create('rep', 'contact', { last_name: 'Two' });
    await h.inTenant(({ prisma: p }) =>
      p.opportunityContactRole.create({
        data: { tenantId: T, opportunityId: opp, contactId: c2, role: 'decision_maker' },
      }),
    );
    await merge('rep', 'contact', { masterId: c1, duplicateIds: [c2] });
    const roles = await h.inTenant(({ prisma: p }) =>
      p.opportunityContactRole.findMany({ where: { opportunityId: opp } }),
    );
    expect(roles.map((r) => r.contactId)).toEqual([c1]);
  });

  it('checks access, the records and their number', async () => {
    const mine = await create('rep', 'lead', { last_name: 'M', company: 'C' });
    const mine2 = await create('rep', 'lead', { last_name: 'M2', company: 'C' });
    const theirs = await create('peer', 'lead', { last_name: 'P', company: 'C' });
    const bosses = await create('boss', 'lead', { last_name: 'B', company: 'C' });
    expect(await refused(merge('rep', 'lead', { masterId: mine, duplicateIds: [] }))).toEqual({
      status: 400,
      errors: ['duplicateIds:one_or_two_others'],
    });
    expect(
      await refused(merge('rep', 'lead', { masterId: mine, duplicateIds: [mine] })),
    ).toMatchObject({ status: 400 });
    // Records the caller cannot see do not exist for them.
    expect(
      await refused(merge('rep', 'lead', { masterId: mine, duplicateIds: [theirs] })),
    ).toMatchObject({ status: 404 });
    // The boss's lead sits above rep in the hierarchy: invisible to rep.
    expect(
      await refused(merge('rep', 'lead', { masterId: mine, duplicateIds: [bosses] })),
    ).toMatchObject({ status: 404 });
    expect(
      await refused(
        merge(
          'rep',
          'lead',
          { masterId: mine, duplicateIds: [mine2] },
          {
            objects: { lead: { ...FULL, delete: false } },
          },
        ),
      ),
    ).toMatchObject({ status: 403 });
    expect(
      await refused(
        merge('rep', 'lead', { masterId: mine, duplicateIds: [mine2], fields: { email: theirs } }),
      ),
    ).toEqual({ status: 400, errors: ['fields.email:not_a_merged_record'] });
    expect(
      await refused(merge('rep', 'opportunity', { masterId: mine, duplicateIds: [mine2] })),
    ).toMatchObject({ status: 404 });
    await h.inTenant(({ prisma: p }) =>
      p.lead.update({
        where: { tenantId_id: { tenantId: T, id: mine2 } },
        data: { convertedAt: new Date() },
      }),
    );
    expect(await refused(merge('rep', 'lead', { masterId: mine, duplicateIds: [mine2] }))).toEqual({
      status: 409,
      errors: ['_record:record_locked'],
    });
  });
});
