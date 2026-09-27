import type { TenantTransaction } from '@sm/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bulkCreate,
  bulkDelete,
  bulkUpdate,
  createRecord,
  massDelete,
  massTransfer,
  massUpdate,
  readStored,
  RecordError,
  selectMatching,
  type RecordContext,
  type RowResult,
} from '../src/index.js';
import { FULL, startHarness, type Harness } from './support.js';

const T = '01920000-0000-7000-8000-000000000d03';
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
const as = <T>(
  user: string,
  fn: (tx: TenantTransaction, ctx: RecordContext) => Promise<T>,
  grants?: Grants,
) => h.inTenant(async (tx) => fn(tx, await h.context(tx, users[user] ?? '', grants)));
const create = (user: string, object: string, fields: Record<string, unknown>) =>
  as(user, async (tx, ctx) => (await createRecord(tx, ctx, object, { fields })).id);
const row = (object: string, id: string) =>
  as(
    'boss',
    (tx, ctx) => {
      const meta = ctx.metadata.object(object);
      if (!meta) throw new Error(object);
      return readStored(tx, meta, id, { includeDeleted: true });
    },
    { system: ['modify_all_data'] },
  );
const summary = (results: RowResult[]) =>
  results.map((r) => (r.ok ? 'ok' : `${String(r.status)} ${r.errors.map((e) => e.code).join()}`));
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

describe('bulk writes (§3.7: batches of 200, per-row results)', () => {
  it('creates what it can; a failing row rolls back alone', async () => {
    const results = await as('rep', (tx, ctx) =>
      bulkCreate(tx, ctx, 'lead', [
        { fields: { last_name: 'One', company: 'Bulk' } },
        { fields: { company: 'Bulk' } },
        { fields: { last_name: 'Three', company: 'Bulk' } },
      ]),
    );
    expect(summary(results)).toEqual(['ok', '422 required', 'ok']);
    expect(results.map((r) => r.index)).toEqual([0, 1, 2]);
    const ids = results.flatMap((r) => (r.ok ? [r.id] : []));
    for (const id of ids) expect((await row('lead', id))?.values['company']).toBe('Bulk');
    // The batch's writes and events are all there; the failed row left nothing behind.
    const events = await h.inTenant((tx) =>
      tx.prisma.outboxEvent.count({ where: { topic: 'automation.record_created' } }),
    );
    expect(events).toBe(2);
  });

  it('refuses batches over 200', async () => {
    const inputs = Array.from({ length: 201 }, () => ({
      fields: { last_name: 'X', company: 'X' },
    }));
    expect(await refused(as('rep', (tx, ctx) => bulkCreate(tx, ctx, 'lead', inputs)))).toEqual({
      status: 400,
      errors: ['_batch:batch_too_large'],
    });
  });

  it('updates each row under its own lock and reports conflicts per row', async () => {
    const a = await create('rep', 'lead', { last_name: 'A', company: 'Upd' });
    const b = await create('rep', 'lead', { last_name: 'B', company: 'Upd' });
    const results = await as('rep', (tx, ctx) =>
      bulkUpdate(tx, ctx, 'lead', [
        { id: a, input: { fields: { title: 'CTO' } }, version: 1 },
        { id: b, input: { fields: { title: 'CFO' } }, version: 7 },
      ]),
    );
    expect(summary(results)).toEqual(['ok', '409 version_mismatch']);
    expect(results[0]).toMatchObject({ id: a, version: 2 });
    expect((await row('lead', b))?.values['title']).toBeNull();
  });

  it('deletes to the bin row by row', async () => {
    const mine = await create('rep', 'lead', { last_name: 'Mine', company: 'Del' });
    const theirs = await create('peer', 'lead', { last_name: 'Theirs', company: 'Del' });
    const results = await as('rep', (tx, ctx) => bulkDelete(tx, ctx, 'lead', [mine, theirs]));
    expect(summary(results)).toEqual(['ok', '404 ']);
    expect((await row('lead', mine))?.deletedAt).not.toBeNull();
  });

  it('propagates errors that are not about a row', async () => {
    await expect(
      as('rep', (tx, ctx) =>
        bulkUpdate(tx, ctx, 'lead', [{ id: 'not-a-uuid', input: { fields: {} }, version: null }]),
      ),
    ).rejects.toThrow();
  });
});

describe('mass actions (§7.5)', () => {
  it('mass update needs mass_update and still checks each row', async () => {
    const mine = await create('rep', 'lead', { last_name: 'M1', company: 'Mass' });
    const theirs = await create('peer', 'lead', { last_name: 'M2', company: 'Mass' });
    expect(
      await refused(
        as('rep', (tx, ctx) => massUpdate(tx, ctx, 'lead', [mine], { fields: { rating: 'hot' } })),
      ),
    ).toEqual({ status: 403, errors: ['_record:needs_mass_update'] });
    const results = await as(
      'rep',
      (tx, ctx) => massUpdate(tx, ctx, 'lead', [mine, theirs], { fields: { rating: 'hot' } }),
      { system: ['mass_update'] },
    );
    expect(summary(results)).toEqual(['ok', '404 ']);
    expect((await row('lead', mine))?.values['rating']).toBe('hot');
    expect((await row('lead', theirs))?.values['rating']).toBeNull();
  });

  it('transfers an account with its contacts and the opportunities its owner had', async () => {
    const account = await create('rep', 'account', { name: 'Initech' });
    const contact = await create('rep', 'contact', { last_name: 'Lumbergh', account_id: account });
    const opp = (name: string, stage: string, user = 'rep') =>
      create(user, 'opportunity', { name, account_id: account, stage, close_date: '2026-12-01' });
    const open = await opp('Open', 'qualification');
    const won = await opp('Won', 'closed_won');
    await h.inTenant(({ prisma }) =>
      prisma.accountTeamMember.create({
        data: { tenantId: T, accountId: account, userId: users['boss'] ?? '' },
      }),
    );
    const transfer = (grants: Grants, options = {}) =>
      as(
        'rep',
        (tx, ctx) => massTransfer(tx, ctx, 'account', [account], users['peer'] ?? '', options),
        grants,
      );
    expect(await refused(transfer({}))).toEqual({
      status: 403,
      errors: ['_record:needs_transfer_records'],
    });
    expect(summary(await transfer({ system: ['transfer_records'] }))).toEqual(['ok']);
    const owner = async (object: string, id: string) => (await row(object, id))?.values['owner_id'];
    expect(await owner('account', account)).toBe(users['peer']);
    expect(await owner('contact', contact)).toBe(users['peer']);
    expect(await owner('opportunity', open)).toBe(users['peer']);
    expect(await owner('opportunity', won)).toBe(users['rep']);
    // Teams stay by default.
    expect(
      await h.inTenant(({ prisma }) =>
        prisma.accountTeamMember.count({ where: { accountId: account } }),
      ),
    ).toBe(1);
  });

  it('can take every opportunity, or none, and drop the teams', async () => {
    const account = await create('rep', 'account', { name: 'Hooli' });
    const won = await create('rep', 'opportunity', {
      name: 'Won',
      account_id: account,
      stage: 'closed_won',
      close_date: '2026-12-01',
    });
    await h.inTenant(({ prisma }) =>
      prisma.accountTeamMember.create({
        data: { tenantId: T, accountId: account, userId: users['boss'] ?? '' },
      }),
    );
    const grants: Grants = { system: ['transfer_records'] };
    await as(
      'rep',
      (tx, ctx) =>
        massTransfer(tx, ctx, 'account', [account], users['peer'] ?? '', {
          opportunities: 'none',
          keepTeams: false,
        }),
      grants,
    );
    expect((await row('opportunity', won))?.values['owner_id']).toBe(users['rep']);
    expect(
      await h.inTenant(({ prisma }) =>
        prisma.accountTeamMember.count({ where: { accountId: account } }),
      ),
    ).toBe(0);
    // Back to the rep (peer owns it now): the rep's own won opportunity stays theirs either way.
    const back = await create('peer', 'opportunity', {
      name: 'Peer won',
      account_id: account,
      stage: 'closed_won',
      close_date: '2026-12-01',
    });
    const results = await as(
      'peer',
      (tx, ctx) =>
        massTransfer(tx, ctx, 'account', [account], users['rep'] ?? '', { opportunities: 'all' }),
      grants,
    );
    expect(summary(results)).toEqual(['ok']);
    expect((await row('opportunity', back))?.values['owner_id']).toBe(users['rep']);
  });

  it('transfers other objects as a plain owner change, which needs Full access', async () => {
    const mine = await create('rep', 'lead', { last_name: 'T1', company: 'Tr' });
    const theirs = await create('peer', 'lead', { last_name: 'T2', company: 'Tr' });
    const results = await as(
      'boss',
      (tx, ctx) => massTransfer(tx, ctx, 'lead', [mine, theirs], users['rep'] ?? ''),
      { system: ['transfer_records'] },
    );
    expect(summary(results)).toEqual(['ok', 'ok']);
    const peerTry = await as(
      'peer',
      (tx, ctx) => massTransfer(tx, ctx, 'lead', [mine], users['peer'] ?? ''),
      { system: ['transfer_records'] },
    );
    expect(summary(peerTry)).toEqual(['404 ']);
  });

  it('mass delete needs Modify All', async () => {
    const id = await create('rep', 'lead', { last_name: 'D', company: 'MassDel' });
    expect(await refused(as('rep', (tx, ctx) => massDelete(tx, ctx, 'lead', [id])))).toEqual({
      status: 403,
      errors: ['_record:needs_modify_all'],
    });
    const results = await as('rep', (tx, ctx) => massDelete(tx, ctx, 'lead', [id]), {
      objects: { lead: { ...FULL, modifyAll: true } },
    });
    expect(summary(results)).toEqual(['ok']);
  });

  it('selects every visible record matching a filter', async () => {
    const a = await create('rep', 'lead', { last_name: 'S1', company: 'Select' });
    const b = await create('rep', 'lead', { last_name: 'S2', company: 'Select' });
    await create('peer', 'lead', { last_name: 'S3', company: 'Select' });
    const ids = await as('rep', (tx, ctx) =>
      selectMatching(tx, ctx, 'lead', { field: 'company', op: 'eq', value: 'Select' }),
    );
    expect(ids).toEqual([a, b].sort());
    const capped = await as('rep', (tx, ctx) => selectMatching(tx, ctx, 'lead', undefined, 1));
    expect(capped).toHaveLength(1);
  });
});
