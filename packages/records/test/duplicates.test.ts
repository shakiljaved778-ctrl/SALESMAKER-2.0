import type { TenantTransaction } from '@sm/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  bulkInsert,
  conditionErrors,
  createRecord,
  deleteRecord,
  RecordError,
  updateRecord,
  type MatchCondition,
  type RecordContext,
  type RowResult,
  type WriteInput,
} from '../src/index.js';
import { startHarness, type Harness } from './support.js';

const T = '01920000-0000-7000-8000-000000000d09';
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

const as = <R>(user: string, fn: (tx: TenantTransaction, ctx: RecordContext) => Promise<R>) =>
  h.inTenant(async (tx) => fn(tx, await h.context(tx, users[user] ?? '')));
const create = (user: string, object: string, fields: Record<string, unknown>) =>
  as(user, (tx, ctx) => createRecord(tx, ctx, object, { fields }));
async function refused(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    if (err instanceof RecordError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

/** Replace the tenant's rules with one matching rule and one duplicate rule. */
async function rule(
  object: string,
  conditions: MatchCondition[],
  options: {
    action?: 'BLOCK' | 'ALERT';
    matchBlank?: boolean;
    bypassProfileIds?: string[];
    onCreate?: boolean;
    onEdit?: boolean;
  } = {},
) {
  await h.inTenant(async ({ prisma: p }) => {
    await p.duplicateRule.deleteMany({});
    await p.matchingRule.deleteMany({});
    const matching = await p.matchingRule.create({
      data: {
        tenantId: T,
        object,
        name: `${object} rule`,
        conditions: conditions as never,
        matchBlank: options.matchBlank ?? false,
      },
    });
    await p.duplicateRule.create({
      data: {
        tenantId: T,
        object,
        name: `${object} ${options.action ?? 'ALERT'}`,
        matchingRuleId: matching.id,
        action: options.action ?? 'ALERT',
        onCreate: options.onCreate ?? true,
        onEdit: options.onEdit ?? true,
        bypassProfileIds: options.bypassProfileIds ?? [],
      },
    });
  });
}

let n = 0;
/** A fresh company per test, so earlier tests' records never match. */
const fresh = () => {
  n += 1;
  return `Test${String(n)}`;
};
beforeEach(async () => {
  await h.inTenant(async ({ prisma: p }) => {
    await p.duplicateRule.deleteMany({});
    await p.matchingRule.deleteMany({});
  });
});

describe('matching rule conditions', () => {
  it('need known fields, fitting methods and one keyed condition', async () => {
    const lead = await as('rep', (_tx, ctx) => Promise.resolve(ctx.metadata.object('lead')));
    const account = await as('rep', (_tx, ctx) => Promise.resolve(ctx.metadata.object('account')));
    if (!lead || !account) throw new Error('metadata');
    expect(conditionErrors(lead, [{ field: 'email', method: 'email' }])).toEqual([]);
    expect(
      conditionErrors(lead, [
        { field: 'company', method: 'company' },
        { field: 'first_name', method: 'fuzzy', threshold: 0.6 },
      ]),
    ).toEqual([]);
    expect(conditionErrors(lead, [])).toEqual([{ field: 'conditions', code: 'required' }]);
    expect(conditionErrors(lead, [{ field: 'nope', method: 'exact' }])).toEqual([
      { field: 'conditions.0.field', code: 'unknown_field' },
      { field: 'conditions', code: 'needs_keyed_condition' },
    ]);
    expect(conditionErrors(lead, [{ field: 'city', method: 'phone' }])).toEqual([
      { field: 'conditions.0.method', code: 'not_for_field' },
      { field: 'conditions', code: 'needs_keyed_condition' },
    ]);
    expect(conditionErrors(lead, [{ field: 'title', method: 'fuzzy' }])).toEqual([
      { field: 'conditions', code: 'needs_keyed_condition' },
    ]);
    expect(conditionErrors(account, [{ field: 'name', method: 'email_domain_name' }])).toEqual([
      { field: 'conditions.0.method', code: 'not_for_field' },
    ]);
  });
});

describe('duplicate rules on single writes (§7.2)', () => {
  it('alert: saves, and reports visible matches found through normalised email', async () => {
    const company = fresh();
    const first = await create('rep', 'lead', {
      last_name: 'Haddad',
      company,
      email: 'Omar.Haddad@GulfTrading.example',
    });
    // peer's lead: rep cannot see it (private, same level), so it is never shown to rep.
    await create('peer', 'lead', {
      last_name: 'Other',
      company,
      email: 'omar.haddad@gulftrading.example',
    });
    await rule('lead', [{ field: 'email', method: 'email' }]);
    const second = await create('rep', 'lead', {
      last_name: 'Haddad',
      company,
      email: '  omar.haddad@GULFTRADING.example ',
    });
    expect(second.duplicates).toEqual([
      expect.objectContaining({ rule: 'lead ALERT', matches: [{ id: first.id, score: 1 }] }),
    ]);
    // The boss sees both through the hierarchy.
    const third = await create('boss', 'lead', {
      last_name: 'Haddad',
      company,
      email: 'omar.haddad@gulftrading.example',
    });
    expect(third.duplicates?.[0]?.matches).toHaveLength(3);
  });

  it('block: refuses whatever the writer can see, naming only what they may see', async () => {
    const company = fresh();
    await create('peer', 'lead', { last_name: 'Hadad', company: `${company} W.L.L.` });
    await rule(
      'lead',
      [
        { field: 'company', method: 'company' },
        { field: 'last_name', method: 'fuzzy', threshold: 0.5 },
      ],
      { action: 'BLOCK' },
    );
    const err = await refused(
      create('rep', 'lead', { last_name: 'Haddad', company: `The ${company.toLowerCase()} LLC` }),
    );
    expect(err.status).toBe(409);
    expect(err.errors).toEqual([
      { field: '_record', code: 'duplicate_blocked', message: 'lead BLOCK' },
    ]);
    expect(err.current).toEqual({ rule: 'lead BLOCK', matches: [] });
    // Different sound, no match: saves.
    await expect(
      create('rep', 'lead', { last_name: 'Smith', company: `${company} WLL` }),
    ).resolves.toMatchObject({ changed: expect.any(Array) as unknown });
  });

  it('lets bypass profiles save past a Block rule', async () => {
    const company = fresh();
    await create('rep', 'lead', { last_name: 'Dup', company, email: `dup@${company}.example` });
    await h.grant(users['boss'] ?? '');
    const profile = await h.inTenant(
      async ({ prisma: p }) =>
        (await p.user.findFirstOrThrow({ where: { id: users['boss'] ?? '' } })).profileId,
    );
    await rule('lead', [{ field: 'email', method: 'email' }], {
      action: 'BLOCK',
      bypassProfileIds: [profile ?? ''],
    });
    expect(
      (
        await refused(
          create('rep', 'lead', { last_name: 'Dup', company, email: `dup@${company}.example` }),
        )
      ).errors[0]?.code,
    ).toBe('duplicate_blocked');
    const saved = await create('boss', 'lead', {
      last_name: 'Dup',
      company,
      email: `dup@${company}.example`,
    });
    expect(saved.duplicates?.[0]?.matches).toHaveLength(1);
  });

  it('matches a phone against phone and mobile, whatever its format', async () => {
    const company = fresh();
    const stored = await create('rep', 'lead', {
      last_name: 'Phone',
      company,
      mobile_phone: '5550 4321',
    });
    await rule('lead', [{ field: 'phone', method: 'phone' }]);
    const created = await create('rep', 'lead', {
      last_name: 'Other',
      company: fresh(),
      phone: '+974 5550-4321',
    });
    expect(created.duplicates?.[0]?.matches.map((m) => m.id)).toContain(stored.id);
  });

  it('matches email domain and surname sound together', async () => {
    const company = fresh();
    const domain = `${company.toLowerCase()}.example`;
    const stored = await create('rep', 'contact', { last_name: 'Okafor', email: `a@${domain}` });
    await rule('contact', [{ field: 'email', method: 'email_domain_name' }]);
    const same = await create('rep', 'contact', { last_name: 'Okafor', email: `b@${domain}` });
    expect(same.duplicates?.[0]?.matches.map((m) => m.id)).toEqual([stored.id]);
    const other = await create('rep', 'contact', { last_name: 'Silva', email: `c@${domain}` });
    expect(other.duplicates).toBeUndefined();
  });

  it('on edit: runs only when a compared field changes, never matches the record itself', async () => {
    const company = fresh();
    const a = await create('rep', 'lead', {
      last_name: 'A',
      company,
      email: `a@${company}.example`,
    });
    const b = await create('rep', 'lead', {
      last_name: 'B',
      company,
      email: `b@${company}.example`,
    });
    await rule('lead', [{ field: 'email', method: 'email' }], { action: 'BLOCK' });
    const update = (fields: Record<string, unknown>) =>
      as('rep', (tx, ctx) => updateRecord(tx, ctx, 'lead', b.id, { fields }, null));
    await expect(update({ city: 'Doha' })).resolves.toBeDefined();
    await expect(update({ email: `b@${company}.example` })).resolves.toBeDefined();
    expect((await refused(update({ email: `a@${company}.example` }))).errors[0]?.code).toBe(
      'duplicate_blocked',
    );
    await rule('lead', [{ field: 'email', method: 'email' }], { action: 'BLOCK', onEdit: false });
    await expect(update({ email: `a@${company}.example` })).resolves.toBeDefined();
    // A deleted record no longer counts.
    await as('rep', (tx, ctx) => deleteRecord(tx, ctx, 'lead', a.id));
    await rule('lead', [{ field: 'email', method: 'email' }], { action: 'BLOCK', onCreate: true });
    await expect(
      create('rep', 'lead', { last_name: 'C', company, email: `a@${company}.example` }),
    ).rejects.toBeInstanceOf(RecordError);
  });

  it('treats blanks as different unless the rule matches blanks', async () => {
    const company = fresh();
    await create('rep', 'lead', { last_name: 'Blank', company });
    await rule('lead', [
      { field: 'company', method: 'company' },
      { field: 'email', method: 'exact' },
    ]);
    const without = await create('rep', 'lead', { last_name: 'Blank2', company });
    expect(without.duplicates).toBeUndefined();
    await rule(
      'lead',
      [
        { field: 'company', method: 'company' },
        { field: 'email', method: 'exact' },
      ],
      { matchBlank: true },
    );
    const withBlank = await create('rep', 'lead', { last_name: 'Blank3', company });
    expect(withBlank.duplicates?.[0]?.matches).toHaveLength(2);
  });

  it('skips duplicate rules when asked (merge writes the survivor)', async () => {
    const company = fresh();
    await create('rep', 'lead', { last_name: 'S', company, email: `s@${company}.example` });
    await rule('lead', [{ field: 'email', method: 'email' }], { action: 'BLOCK' });
    await expect(
      as('rep', (tx, ctx) =>
        createRecord(
          tx,
          ctx,
          'lead',
          { fields: { last_name: 'S2', company, email: `s@${company}.example` } },
          { duplicates: 'skip' },
        ),
      ),
    ).resolves.toBeDefined();
  });
});

const outcome = (r: RowResult) =>
  r.ok ? 'ok' : `${String(r.status)} ${r.errors.map((e) => e.code).join(',')}`;

describe('duplicate rules on bulk inserts', () => {
  it('blocks rows matching stored records and earlier rows of the batch', async () => {
    const company = fresh();
    const email = (x: string) => `${x}@${company}.example`;
    await create('rep', 'lead', { last_name: 'Stored', company, email: email('stored') });
    await rule('lead', [{ field: 'email', method: 'email' }], { action: 'BLOCK' });
    const inputs: WriteInput[] = [
      { fields: { last_name: 'R0', company, email: email('stored') } },
      { fields: { last_name: 'R1', company, email: email('new') } },
      { fields: { last_name: 'R2', company, email: email('NEW') } },
      { fields: { last_name: 'R3', company, email: email('other') } },
      // Fails a required field: never counts as an earlier row.
      { fields: { company, email: email('ghost') } },
      { fields: { last_name: 'R5', company, email: email('ghost') } },
    ];
    const results = await as('rep', (tx, ctx) => bulkInsert(tx, ctx, 'lead', inputs));
    expect(results.map(outcome)).toEqual([
      '409 duplicate_blocked',
      'ok',
      '409 duplicate_blocked',
      'ok',
      '422 required',
      'ok',
    ]);
    const second = results[2];
    if (second?.ok !== false) throw new Error('expected a failure');
    expect(second.errors[0]?.message).toBe('lead BLOCK');
  });

  it('alerts on matches but saves, and can skip the rules', async () => {
    const company = fresh();
    const email = `same@${company}.example`;
    const stored = await create('rep', 'lead', { last_name: 'Stored', company, email });
    await rule('lead', [{ field: 'email', method: 'email' }]);
    const results = await as('rep', (tx, ctx) =>
      bulkInsert(tx, ctx, 'lead', [
        { fields: { last_name: 'A', company, email } },
        { fields: { last_name: 'B', company, email } },
      ]),
    );
    expect(results.map(outcome)).toEqual(['ok', 'ok']);
    expect(results[0]?.ok && results[0].duplicates?.[0]?.matches).toEqual([
      { id: stored.id, score: 1 },
    ]);
    expect(results[1]?.ok && results[1].duplicates?.map((d) => d.matches)).toEqual([
      [{ id: stored.id, score: 1 }],
      [{ id: null, batchIndex: 0, score: 1 }],
    ]);
    await rule('lead', [{ field: 'email', method: 'email' }], { action: 'BLOCK' });
    const skipped = await as('rep', (tx, ctx) =>
      bulkInsert(tx, ctx, 'lead', [{ fields: { last_name: 'C', company, email } }], {
        duplicates: 'skip',
      }),
    );
    expect(skipped.map(outcome)).toEqual(['ok']);
  });
});
