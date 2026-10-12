import type { TenantTransaction } from '@sm/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  assignmentEnv,
  assignRecords,
  bulkInsert,
  createRecord,
  entryCriteriaError,
  readStored,
  type RecordContext,
} from '../src/index.js';
import { startHarness, type Harness } from './support.js';

const T = '01920000-0000-7000-8000-000000000d0c';
let h: Harness;
const u: Record<string, string> = {};
let queue = '';

beforeAll(async () => {
  h = await startHarness(T);
  for (const name of ['admin', 'ana', 'ben', 'cy', 'dee']) u[name] = await h.user(name);
  queue = await h.inTenant(async ({ prisma: p }) => {
    const q = await p.queue.create({ data: { tenantId: T, name: 'Inbound' } });
    await p.queueObject.create({ data: { tenantId: T, queueId: q.id, object: 'lead' } });
    await p.queueMember.createMany({
      data: ['ana', 'ben'].map((n) => ({
        tenantId: T,
        queueId: q.id,
        memberType: 'USER' as const,
        userId: u[n] ?? '',
      })),
    });
    return q.id;
  });
});

afterAll(async () => {
  await h.dispose();
});

const as = <R>(fn: (tx: TenantTransaction, ctx: RecordContext) => Promise<R>) =>
  h.inTenant(async (tx) => fn(tx, await h.context(tx, u['admin'] ?? '')));

let n = 0;
const leads = (count: number, fields: Record<string, unknown> = {}) =>
  as(async (tx, ctx) => {
    const results = await bulkInsert(
      tx,
      ctx,
      'lead',
      Array.from({ length: count }, () => {
        n += 1;
        return { fields: { last_name: `L${String(n)}`, company: `Co ${String(n)}`, ...fields } };
      }),
    );
    return results.flatMap((r) => (r.ok ? [r.id] : []));
  });

type EntryInput = {
  method: string;
  criteria?: unknown;
  formula?: string;
  settings?: Record<string, unknown>;
  targetUserId?: string;
  targetQueueId?: string;
  members?: { userId?: string; queueId?: string; weight?: number }[];
};
/** Replace the tenant's lead rule with these entries. */
async function rule(entries: EntryInput[]) {
  return h.inTenant(async ({ prisma: p }) => {
    await p.assignmentRule.deleteMany({});
    await p.roundRobinCursor.deleteMany({});
    const r = await p.assignmentRule.create({
      data: { tenantId: T, object: 'lead', name: 'Leads', isDefault: true },
    });
    for (const [i, e] of entries.entries()) {
      const entry = await p.assignmentRuleEntry.create({
        data: {
          tenantId: T,
          ruleId: r.id,
          sortOrder: i,
          method: e.method as never,
          criteria: (e.criteria ?? undefined) as never,
          formula: e.formula ?? null,
          settings: (e.settings ?? {}) as never,
          targetUserId: e.targetUserId ?? null,
          targetQueueId: e.targetQueueId ?? null,
        },
      });
      for (const m of e.members ?? [])
        await p.assignmentPoolMember.create({
          data: {
            tenantId: T,
            entryId: entry.id,
            memberType: m.queueId ? 'QUEUE' : 'USER',
            userId: m.userId ?? null,
            queueId: m.queueId ?? null,
            weight: m.weight ?? 1,
          },
        });
    }
    return r.id;
  });
}
const run = (ids: string[], source = 'run') =>
  as((tx, ctx) => assignRecords(tx, assignmentEnv(ctx), 'lead', ids, { source }));
const ownerOf = (id: string) =>
  as(async (tx, ctx) => {
    const meta = ctx.metadata.object('lead');
    if (!meta) throw new Error('lead');
    return (await readStored(tx, meta, id))?.values['owner_id'];
  });
const tally = (owners: (string | undefined)[]) => {
  const out: Record<string, number> = {};
  for (const o of owners) {
    const name = Object.entries(u).find(([, id]) => id === o)?.[0] ?? String(o);
    out[name] = (out[name] ?? 0) + 1;
  }
  return out;
};
const users = (...names: string[]) => names.map((x) => ({ userId: u[x] ?? '' }));

beforeEach(async () => {
  await h.inTenant(async ({ prisma: p }) => {
    await p.userAvailability.deleteMany({});
    await p.userCapacity.deleteMany({});
    await p.userSkill.deleteMany({});
  });
});

describe('assignment methods (§7.3)', () => {
  it('round robin takes turns across batches and skips who is unavailable', async () => {
    await rule([{ method: 'ROUND_ROBIN', members: users('ana', 'ben', 'cy') }]);
    const first = await run(await leads(4));
    const second = await run(await leads(2));
    const order = [...first, ...second].map((o) => o.ownerId);
    const names = ['ana', 'ben', 'cy'].map((x) => u[x]).sort();
    // Six records over three users, in id order, carried on across batches: twice each.
    expect(order).toEqual([...names, ...names]);
    await h.inTenant(({ prisma: p }) =>
      p.userAvailability.create({
        data: { tenantId: T, userId: u['ben'] ?? '', outOfOffice: true },
      }),
    );
    const third = await run(await leads(4));
    expect(tally(third.map((o) => o.ownerId))).toEqual({ ana: 2, cy: 2 });
    const log = await h.inTenant(({ prisma: p }) =>
      p.assignmentLog.findFirstOrThrow({
        where: { recordId: third[0]?.recordId ?? '' },
      }),
    );
    expect(log).toMatchObject({ method: 'ROUND_ROBIN', ownerType: 'USER', source: 'run' });
    expect(JSON.stringify(log.candidates)).toMatch(/out_of_office|"userId"/);
  });

  it('weighted hands out records by share, fair over many rounds', async () => {
    await rule([
      {
        method: 'WEIGHTED',
        members: [
          { userId: u['ana'] ?? '', weight: 3 },
          { userId: u['ben'] ?? '', weight: 1 },
        ],
      },
    ]);
    const out = await run(await leads(40));
    expect(tally(out.map((o) => o.ownerId))).toEqual({ ana: 30, ben: 10 });
  });

  it('load balancing gives to whoever has the fewest open records; capacity and daily limits apply', async () => {
    await rule([{ method: 'LOAD_BALANCED', members: users('cy', 'dee') }]);
    // cy already holds open leads.
    const held = await leads(3);
    await h.inTenant(({ prisma: p }) =>
      p.lead.updateMany({ where: { id: { in: held } }, data: { ownerId: u['cy'] ?? '' } }),
    );
    const before = await h.inTenant(({ prisma: p }) =>
      p.lead.count({ where: { ownerId: u['dee'] ?? '', deletedAt: null } }),
    );
    const out = await run(await leads(4));
    const after = before + (tally(out.map((o) => o.ownerId))['dee'] ?? 0);
    expect(after).toBeGreaterThan(0);
    // dee may take no more new records today: everything goes to cy.
    await h.inTenant(({ prisma: p }) =>
      p.userCapacity.create({
        data: { tenantId: T, userId: u['dee'] ?? '', object: 'lead', maxNewPerDay: 0 },
      }),
    );
    expect(tally((await run(await leads(2))).map((o) => o.ownerId))).toEqual({ cy: 2 });
    // Both at capacity, no fallback: owners are kept and the log says why.
    await h.inTenant(({ prisma: p }) =>
      p.userCapacity.create({
        data: { tenantId: T, userId: u['cy'] ?? '', object: 'lead', maxOpen: 0 },
      }),
    );
    const kept = await run(await leads(1));
    expect(kept[0]).toMatchObject({
      changed: false,
      reason: expect.stringContaining('owner kept') as unknown,
    });
  });

  it('skills-based needs every skill, a field value included', async () => {
    await rule([
      {
        method: 'SKILLS_BASED',
        settings: { skills: ['enterprise'], skillField: 'city' },
        members: users('ana', 'ben', 'cy'),
      },
    ]);
    await h.inTenant(({ prisma: p }) =>
      p.userSkill.createMany({
        data: [
          { tenantId: T, userId: u['ana'] ?? '', skill: 'enterprise' },
          { tenantId: T, userId: u['ben'] ?? '', skill: 'enterprise' },
          { tenantId: T, userId: u['ben'] ?? '', skill: 'city:doha' },
          { tenantId: T, userId: u['cy'] ?? '', skill: 'city:doha' },
        ],
      }),
    );
    const out = await run(await leads(2, { city: 'Doha' }));
    expect(tally(out.map((o) => o.ownerId))).toEqual({ ben: 2 });
  });

  it('sticky account, queue and specific user with fallback, in entry order by criteria', async () => {
    const account = await as(
      async (tx, ctx) =>
        (
          await createRecord(tx, ctx, 'account', {
            fields: { name: 'Gulf Trading', owner_id: u['dee'] },
          })
        ).id,
    );
    expect(account).toBeDefined();
    await rule([
      { method: 'STICKY_ACCOUNT' },
      {
        method: 'QUEUE',
        criteria: { field: 'city', op: 'eq', value: 'Dubai' },
        targetQueueId: queue,
      },
      {
        method: 'SPECIFIC_USER',
        formula: "ISPICKVAL(lead_source, 'web')",
        targetUserId: u['ben'] ?? '',
        settings: { fallback: { type: 'QUEUE', id: queue } },
      },
    ]);
    const [sticky] = await leads(1, { company: 'Gulf Trading W.L.L.' });
    const [dubai] = await leads(1, { city: 'Dubai' });
    const [web] = await leads(1, { lead_source: 'web' });
    const [other] = await leads(1);
    const out = await run([sticky ?? '', dubai ?? '', web ?? '', other ?? '']);
    const by = new Map(out.map((o) => [o.recordId, o]));
    expect(by.get(sticky ?? '')).toMatchObject({ method: 'STICKY_ACCOUNT', ownerId: u['dee'] });
    expect(by.get(dubai ?? '')).toMatchObject({
      method: 'QUEUE',
      ownerType: 'QUEUE',
      ownerId: queue,
    });
    expect(by.get(web ?? '')).toMatchObject({ method: 'SPECIFIC_USER', ownerId: u['ben'] });
    // No entry matched: untouched, not logged.
    expect(by.has(other ?? '')).toBe(false);
    expect(await ownerOf(dubai ?? '')).toBe(queue);
    // ben out of office: the fallback queue.
    await h.inTenant(({ prisma: p }) =>
      p.userAvailability.create({
        data: { tenantId: T, userId: u['ben'] ?? '', outOfOffice: true },
      }),
    );
    const [web2] = await leads(1, { lead_source: 'web' });
    expect((await run([web2 ?? '']))[0]).toMatchObject({ ownerType: 'QUEUE', ownerId: queue });
  });

  it('writes owners with history, audit and events', async () => {
    await rule([{ method: 'SPECIFIC_USER', targetUserId: u['cy'] ?? '' }]);
    const [id] = await leads(1);
    await run([id ?? '']);
    expect(await ownerOf(id ?? '')).toBe(u['cy']);
    const audited = await h.inTenant(({ prisma: p }) =>
      p.auditLog.findFirst({ where: { recordId: id ?? '', action: 'record.assigned' } }),
    );
    expect(audited?.payload).toMatchObject({ fields: ['owner_id'], method: 'SPECIFIC_USER' });
    const events = await h.inTenant(({ prisma: p }) =>
      p.outboxEvent.findMany({ where: { aggregateId: id ?? '' }, select: { topic: true } }),
    );
    expect(events.map((e) => e.topic)).toEqual(
      expect.arrayContaining(['automation.owner_changed']) as unknown,
    );
  });
});

describe('assignment on capture', () => {
  it('runs on create and on bulk inserts when asked', async () => {
    await rule([{ method: 'ROUND_ROBIN', members: users('ana', 'ben') }]);
    const single = await as((tx, ctx) =>
      createRecord(
        tx,
        ctx,
        'lead',
        { fields: { last_name: 'S', company: 'S' } },
        { assign: { source: 'api' } },
      ),
    );
    expect(single.assignment).toMatchObject({ method: 'ROUND_ROBIN', changed: true });
    const plain = await as((tx, ctx) =>
      createRecord(tx, ctx, 'lead', { fields: { last_name: 'P', company: 'P' } }),
    );
    expect(plain.assignment).toBeUndefined();
    const bulk = await as((tx, ctx) =>
      bulkInsert(
        tx,
        ctx,
        'lead',
        [
          { fields: { last_name: 'B1', company: 'B' } },
          { fields: { last_name: 'B2', company: 'B' } },
        ],
        { assign: { source: 'import' } },
      ),
    );
    expect(bulk.map((r) => r.ok && r.assignment?.method)).toEqual(['ROUND_ROBIN', 'ROUND_ROBIN']);
  });

  it('never hands out the same turn twice when batches run at once', async () => {
    await rule([{ method: 'ROUND_ROBIN', members: users('ana', 'ben', 'cy', 'dee') }]);
    const batches = await Promise.all([leads(3), leads(3), leads(2)]);
    const results = await Promise.all(batches.map((ids) => run(ids, 'import')));
    expect(Object.values(tally(results.flat().map((o) => o.ownerId)))).toEqual([2, 2, 2, 2]);
  });

  it('reports criteria that cannot run', async () => {
    const metadata = await as((_tx, ctx) => Promise.resolve(ctx.metadata));
    expect(entryCriteriaError(metadata, 'lead', { formula: 'NOPE(' })).toBe('invalid_formula');
    expect(
      entryCriteriaError(metadata, 'lead', { criteria: { field: 'nope', op: 'eq', value: 1 } }),
    ).toBe('invalid_criteria');
    expect(
      entryCriteriaError(metadata, 'lead', {
        criteria: { field: 'city', op: 'eq', value: 'Doha' },
      }),
    ).toBeNull();
  });
});
