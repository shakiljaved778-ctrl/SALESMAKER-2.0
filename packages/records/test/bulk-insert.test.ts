import { createCellPrisma, disposeCellPrisma, withTenant, type TenantTransaction } from '@sm/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  bulkCreate,
  bulkInsert,
  BULK_INSERT_BATCH,
  readStored,
  RecordError,
  type RecordContext,
  type RowResult,
  type WriteInput,
} from '../src/index.js';
import { startHarness, type Harness } from './support.js';

const T = '01920000-0000-7000-8000-000000000d08';
let h: Harness;
const users: Record<string, string> = {};
let group = '';

beforeAll(async () => {
  h = await startHarness(T);
  await h.unit('sales');
  await h.unit('emea', 'sales');
  users['boss'] = await h.user('boss', 'sales');
  users['rep'] = await h.user('rep', 'emea');
  users['peer'] = await h.user('peer', 'emea');
  users['gone'] = await h.user('gone', 'emea');
  await h.inTenant(async ({ prisma: p }) => {
    await p.user.update({
      where: { tenantId_id: { tenantId: T, id: users['gone'] ?? '' } },
      data: { status: 'DISABLED', deactivatedAt: new Date() },
    });
    group = (await p.publicGroup.create({ data: { tenantId: T, name: 'Doha team' } })).id;
    await p.sharingRule.create({
      data: {
        tenantId: T,
        object: 'lead',
        name: 'Doha leads',
        kind: 'CRITERIA',
        criteria: { field: 'city', op: 'eq', value: 'Doha' },
        targetType: 'GROUP',
        targetId: group,
        access: 1,
      },
    });
    const contactObject = await p.objectDefinition.findFirstOrThrow({
      where: { apiName: 'contact' },
    });
    const leadObject = await p.objectDefinition.findFirstOrThrow({ where: { apiName: 'lead' } });
    await p.validationRule.createMany({
      data: [
        {
          tenantId: T,
          objectId: contactObject.id,
          apiName: 'no_blocked_accounts',
          formula: "NOT(ISBLANK(account_id)) && account.name = 'Blocked Co'",
          errorMessage: 'That account takes no new contacts.',
        },
        {
          tenantId: T,
          objectId: leadObject.id,
          apiName: 'working_needs_email',
          formula: "ISPICKVAL(status, 'working') && ISBLANK(email)",
          errorMessage: 'Add an email first.',
          errorField: 'email',
        },
      ],
    });
  });
});

afterAll(async () => {
  await h.dispose();
});

const as = <R>(user: string, fn: (tx: TenantTransaction, ctx: RecordContext) => Promise<R>) =>
  h.inTenant(async (tx) => fn(tx, await h.context(tx, users[user] ?? '')));

/** A small deterministic PRNG (mulberry32), so a failing case can be replayed from its seed. */
function rng(seed: number) {
  let a = seed;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <V>(items: readonly V[]): V => items[Math.floor(next() * items.length)] as V;
  const maybe = (p: number) => next() < p;
  return { pick, maybe };
}

const BOGUS = '01920000-0000-7000-8000-00000000beef';

function randomLead(r: ReturnType<typeof rng>, i: number): WriteInput {
  const fields: Record<string, unknown> = {};
  if (r.maybe(0.92))
    fields['last_name'] = `${r.pick(['Haddad', 'Chen', 'Okafor', 'Silva'])}${String(i)}`;
  if (r.maybe(0.92)) fields['company'] = r.pick(['Gulf Trading', 'Pixelcraft', 'Aurelia']);
  if (r.maybe(0.5))
    fields['email'] = r.maybe(0.9) ? `lead${String(i)}@example.com` : 'not-an-email';
  if (r.maybe(0.4)) fields['city'] = r.pick(['Doha', 'Dubai', 'Riyadh']);
  if (r.maybe(0.3))
    fields['status'] = r.pick(['open', 'working', 'nurture', 'converted', 'no_such_status']);
  if (r.maybe(0.3))
    fields['owner_id'] = r.pick([users['rep'], users['peer'], users['gone'], BOGUS]);
  if (r.maybe(0.3)) fields['annual_revenue'] = r.pick(['1000.50', '250000', 'lots']);
  if (r.maybe(0.2)) fields['number_of_employees'] = r.pick([12, 3400, -1]);
  if (r.maybe(0.15)) fields['lead_source'] = r.pick(['web', 'partner', 'carrier_pigeon']);
  if (r.maybe(0.05)) fields['converted_at'] = '2026-01-01T00:00:00Z';
  if (r.maybe(0.03)) fields['no_such_field'] = 'x';
  const input: WriteInput = { fields };
  if (r.maybe(0.3)) input.currencyCode = r.pick(['USD', 'EUR', 'GBP']);
  return input;
}

function randomContact(r: ReturnType<typeof rng>, i: number, accounts: string[]): WriteInput {
  const fields: Record<string, unknown> = {};
  if (r.maybe(0.95)) fields['last_name'] = `Contact${String(i)}`;
  if (r.maybe(0.8)) fields['account_id'] = r.maybe(0.95) ? r.pick(accounts) : BOGUS;
  if (r.maybe(0.4)) fields['owner_id'] = r.pick([users['rep'], users['peer'], users['boss']]);
  if (r.maybe(0.3)) fields['email'] = `c${String(i)}@example.com`;
  return { fields };
}

const SKIP = new Set(['id', 'record_number', 'created_at', 'updated_at']);

/** What a created record looks like, apart from its identity and timestamps. */
async function snapshot(tx: TenantTransaction, ctx: RecordContext, object: string, id: string) {
  const meta = ctx.metadata.object(object);
  if (!meta) throw new Error(object);
  const stored = await readStored(tx, meta, id);
  const values = Object.fromEntries(
    Object.entries(stored?.values ?? {}).filter(([k]) => !SKIP.has(k)),
  );
  const extra = await sql<Record<string, unknown>>`
    SELECT version, created_by, updated_by, custom,
      ${meta.fields.some((f) => f.type === 'currency') ? sql`currency_code, annual_revenue_corporate::text AS corporate, corporate_rate_date::text AS rate_date` : sql`NULL AS currency_code`},
      ${object === 'lead' || object === 'contact' ? sql`match_email, match_name_key` : sql`NULL AS match_email`}
    FROM ${sql.table(object)} WHERE tenant_id = ${T}::uuid AND id = ${id}::uuid`.execute(tx.kysely);
  const shares = await sql<{ s: string }>`
    SELECT principal_type || ':' || principal_id || ':' || access || ':' || reason AS s
    FROM record_share WHERE tenant_id = ${T}::uuid AND record_id = ${id}::uuid ORDER BY 1`.execute(
    tx.kysely,
  );
  const audits = await tx.prisma.auditLog.findMany({
    where: { recordId: id },
    select: { action: true, object: true, payload: true, actorId: true },
  });
  const events = await tx.prisma.outboxEvent.findMany({
    where: { aggregateId: id },
    select: { topic: true, aggregateType: true, payload: true },
  });
  const number = stored?.values['record_number'];
  return {
    values,
    extra: extra.rows[0],
    numbered: typeof number === 'string' && /^[A-Z]+-\d{6}$/.test(number),
    shares: shares.rows.map((r) => r.s),
    audits,
    events: events.map((e) => ({
      ...e,
      payload: { ...(e.payload as Record<string, unknown>), id: 'x' },
    })),
  };
}

const outcome = (r: RowResult) =>
  r.ok ? 'ok' : `${String(r.status)} ${r.errors.map((e) => `${e.field}:${e.code}`).join(',')}`;

/** Run the same inputs through the single-row path and the set-based path, and compare. */
async function compare(object: string, inputs: WriteInput[]) {
  const single: RowResult[] = [];
  for (let i = 0; i < inputs.length; i += 40)
    single.push(
      ...(await as('rep', (tx, ctx) => bulkCreate(tx, ctx, object, inputs.slice(i, i + 40)))),
    );
  const bulk = await as('rep', (tx, ctx) => bulkInsert(tx, ctx, object, inputs));
  expect(bulk.map(outcome)).toEqual(single.map(outcome));
  expect(bulk.map((r) => r.index)).toEqual(inputs.map((_, i) => i));
  for (const [i, a] of single.entries()) {
    const b = bulk[i];
    if (!a.ok || !b?.ok) continue;
    const [left, right] = await as('boss', async (tx, ctx) => [
      await snapshot(tx, ctx, object, a.id),
      await snapshot(tx, ctx, object, b.id),
    ]);
    expect(right, `row ${String(i)}`).toEqual(left);
  }
  return { single, bulk };
}

describe('bulkInsert: the set-based path is the single-row path (P03 T05)', () => {
  it('matches createRecord on random leads: results, values, numbers, shares, audit, events', async () => {
    const r = rng(20261011);
    const inputs = Array.from({ length: 160 }, (_, i) => randomLead(r, i));
    const { bulk } = await compare('lead', inputs);
    // The generator covers both outcomes and every kind of refusal it can produce.
    const outcomes = new Set(bulk.map(outcome).map((o) => o.split(' ')[0]));
    expect(outcomes).toEqual(new Set(['ok', '400', '403', '422'].filter((s) => outcomes.has(s))));
    expect(bulk.filter((x) => x.ok).length).toBeGreaterThan(40);
    expect(bulk.filter((x) => !x.ok).length).toBeGreaterThan(20);
  }, 60_000);

  it('matches createRecord on contacts: references, cross-object validation rules, implicit shares', async () => {
    // Owned by rep, who adds the contacts; other owners' contacts share the accounts implicitly.
    const accounts = await as('rep', async (tx, ctx) =>
      (
        await bulkInsert(tx, ctx, 'account', [
          { fields: { name: 'Aurelia Bank' } },
          { fields: { name: 'Blocked Co' } },
          { fields: { name: 'Gulf Trading' } },
        ])
      ).flatMap((x) => (x.ok ? [x.id] : [])),
    );
    expect(accounts).toHaveLength(3);
    const r = rng(7);
    const inputs = Array.from({ length: 80 }, (_, i) => randomContact(r, i, accounts));
    const { bulk } = await compare('contact', inputs);
    expect(bulk.some((x) => !x.ok && x.errors[0]?.code === 'validation_rule')).toBe(true);
    expect(bulk.some((x) => !x.ok && x.errors[0]?.code === 'invalid_reference')).toBe(true);
    // Owners of the new contacts got Read on their accounts (IMPLICIT_PARENT).
    const parentShares = await h.inTenant(
      async (tx) =>
        (
          await sql<{ n: string }>`SELECT count(*)::text AS n FROM record_share
            WHERE tenant_id = ${T}::uuid AND reason = 'IMPLICIT_PARENT'`.execute(tx.kysely)
        ).rows[0]?.n,
    );
    expect(Number(parentShares)).toBeGreaterThan(0);
  }, 60_000);

  it('isolates a row the database refuses and inserts the rest', async () => {
    // A check constraint the in-memory validation does not know about (added as the owner).
    const owner = createCellPrisma(h.db.migratorUrl);
    await owner.$executeRawUnsafe(
      `ALTER TABLE lead ADD CONSTRAINT test_no_forbidden_company CHECK (company <> 'Forbidden')`,
    );
    const inputs = ['A', 'B', 'Forbidden', 'C', 'D', 'Forbidden', 'E'].map((company) => ({
      fields: { last_name: 'Iso', company },
    }));
    try {
      const results = await as('rep', (tx, ctx) => bulkInsert(tx, ctx, 'lead', inputs));
      expect(results.map(outcome)).toEqual([
        'ok',
        'ok',
        '422 _record:invalid_value',
        'ok',
        'ok',
        '422 _record:invalid_value',
        'ok',
      ]);
      const stored = await h.inTenant(async (tx) =>
        (
          await sql<{ company: string }>`SELECT company FROM lead
              WHERE tenant_id = ${T}::uuid AND last_name = 'Iso' ORDER BY id`.execute(tx.kysely)
        ).rows.map((x) => x.company),
      );
      expect(stored).toEqual(['A', 'B', 'C', 'D', 'E']);
    } finally {
      await owner.$executeRawUnsafe(
        'ALTER TABLE lead DROP CONSTRAINT IF EXISTS test_no_forbidden_company',
      );
      await disposeCellPrisma(owner);
    }
  });

  it('refuses batches that are too large or objects the caller cannot create', async () => {
    const tooMany = Array.from({ length: BULK_INSERT_BATCH + 1 }, () => ({ fields: {} }));
    await expect(as('rep', (tx, ctx) => bulkInsert(tx, ctx, 'lead', tooMany))).rejects.toThrow(
      RecordError,
    );
    await expect(
      h.inTenant(async (tx) =>
        bulkInsert(
          tx,
          await h.context(tx, users['rep'] ?? '', {
            objects: {
              lead: {
                read: true,
                create: false,
                edit: false,
                delete: false,
                viewAll: false,
                modifyAll: false,
              },
            },
          }),
          'lead',
          [{ fields: { last_name: 'X', company: 'Y' } }],
        ),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(await as('rep', (tx, ctx) => bulkInsert(tx, ctx, 'lead', []))).toEqual([]);
  });

  it('keeps the single-row path for opportunities, with per-row results', async () => {
    const results = await as('rep', (tx, ctx) =>
      bulkInsert(tx, ctx, 'opportunity', [
        { fields: { name: 'Deal', close_date: '2026-12-01' } },
        { fields: { close_date: '2026-12-01' } },
      ]),
    );
    expect(results.map(outcome)).toEqual(['ok', '422 name:required']);
  });

  it('inserts 1,000 leads in one call, with their rule shares', async () => {
    const inputs = Array.from({ length: 1000 }, (_, i) => ({
      fields: {
        last_name: `Speed${String(i)}`,
        company: 'Throughput',
        city: i % 3 ? 'Doha' : 'Rome',
      },
    }));
    const started = performance.now();
    const results = await withTenant(
      h.prisma,
      { tenantId: T },
      async (tx) => bulkInsert(tx, await h.context(tx, users['rep'] ?? ''), 'lead', inputs),
      { timeoutMs: 60_000, statementTimeoutMs: 30_000 },
    );
    const ms = performance.now() - started;
    expect(results.every((x) => x.ok)).toBe(true);
    // A smoke bound only (shared CI runners vary); the throughput budget is measured in T29.
    expect(ms).toBeLessThan(20_000);
    const ruleShares = await h.inTenant(
      async (tx) =>
        (
          await sql<{ n: string }>`SELECT count(*)::text AS n FROM record_share s
            JOIN lead l ON l.tenant_id = s.tenant_id AND l.id = s.record_id
            WHERE s.tenant_id = ${T}::uuid AND s.reason = 'RULE' AND l.company = 'Throughput'`.execute(
            tx.kysely,
          )
        ).rows[0]?.n,
    );
    expect(Number(ruleShares)).toBe(inputs.filter((x) => x.fields.city === 'Doha').length);
  });
});
