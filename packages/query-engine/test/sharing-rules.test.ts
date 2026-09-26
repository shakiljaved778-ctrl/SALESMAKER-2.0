import { withTenant, type TenantTransaction } from '@sm/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  evaluateRulesForRecord,
  grantManualShare,
  NIL_UUID,
  recalculateRule,
  removeRuleShares,
  revokeManualShare,
  type Db,
  type RecalculationProgress,
  type SharingRuleDefinition,
} from '../src/index.js';
import { createFixture, seedTenantSettings, type Fixture } from './fixtures.js';

const T = '01920000-0000-7000-8000-000000000c01';
const id: Record<string, string> = {};
const get = (n: string) => {
  const v = id[n];
  if (!v) throw new Error(`no fixture ${n}`);
  return v;
};
let f: Fixture;

const inTenant = <T>(fn: (tx: TenantTransaction) => Promise<T>) => f.inTenant(T, fn);
const db = (tx: TenantTransaction) => tx.kysely as unknown as Db;

/** Shares of fixture accounts as "record>principal@access/reason". */
async function sharesOf(ruleId?: string) {
  const rows = await inTenant((tx) =>
    tx.prisma.recordShare.findMany({
      where: { object: 'account', ...(ruleId ? { sourceId: ruleId } : {}) },
    }),
  );
  const name = new Map(Object.entries(id).map(([k, v]) => [v, k]));
  return rows
    .map(
      (r) =>
        `${name.get(r.recordId) ?? '?'}>${name.get(r.principalId) ?? '?'}@${String(r.access)}/${r.reason}`,
    )
    .sort();
}

function rule(overrides: Partial<SharingRuleDefinition>): SharingRuleDefinition {
  return {
    id: get('rule'),
    object: 'account',
    kind: 'OWNER',
    sourceType: 'GROUP',
    sourceId: get('reps'),
    criteria: null,
    targetType: 'GROUP',
    targetId: get('managers'),
    access: 1,
    active: true,
    ...overrides,
  };
}

beforeAll(async () => {
  f = await createFixture();
  await seedTenantSettings(f, T, 'rules');
  await inTenant(async (tx) => {
    const p = tx.prisma;
    id['sales'] = (await p.orgUnit.create({ data: { tenantId: T, name: 'sales' } })).id;
    id['emea'] = (
      await p.orgUnit.create({ data: { tenantId: T, name: 'emea', parentId: get('sales') } })
    ).id;
    for (const [name, unit] of [
      ['ann', 'sales'],
      ['bob', 'emea'],
      ['cat', null],
    ] as const) {
      id[name] = (
        await p.user.create({
          data: {
            tenantId: T,
            email: `${name}@rules.test`,
            name,
            orgUnitId: unit ? get(unit) : null,
          },
        })
      ).id;
    }
    id['reps'] = (await p.publicGroup.create({ data: { tenantId: T, name: 'reps' } })).id;
    id['managers'] = (await p.publicGroup.create({ data: { tenantId: T, name: 'managers' } })).id;
    await p.groupMember.create({
      data: { tenantId: T, groupId: get('reps'), memberType: 'USER', userId: get('cat') },
    });
    id['q'] = (await p.queue.create({ data: { tenantId: T, name: 'q' } })).id;
    await p.queueMember.create({
      data: { tenantId: T, queueId: get('q'), memberType: 'USER', userId: get('bob') },
    });
    const stored = await p.sharingRule.create({
      data: {
        tenantId: T,
        object: 'account',
        name: 'reps to managers',
        kind: 'OWNER',
        sourceType: 'GROUP',
        sourceId: get('reps'),
        targetType: 'GROUP',
        targetId: get('managers'),
        access: 1,
      },
    });
    id['rule'] = stored.id;
    for (const [name, owner, amount] of [
      ['acc_ann', 'ann', 100],
      ['acc_bob', 'bob', 5000],
      ['acc_cat', 'cat', 20000],
      ['acc_cat2', 'cat', 1],
    ] as const) {
      const [row] = await tx.kysely
        .insertInto('fx_account')
        .values({ tenant_id: T, owner_id: get(owner), name, amount })
        .returning('id')
        .execute();
      id[name] = String(row?.['id']);
    }
  });
});

afterAll(async () => {
  await f.dispose();
});

describe('manual shares (§6.3)', () => {
  it('grants, upgrades and revokes a manual share', async () => {
    const share = {
      tenantId: T,
      object: 'account',
      recordId: get('acc_ann'),
      principal: { type: 'USER' as const, id: get('bob') },
    };
    await inTenant((tx) =>
      grantManualShare(db(tx), { ...share, access: 1, createdBy: get('ann') }),
    );
    await inTenant((tx) => grantManualShare(db(tx), { ...share, access: 2 }));
    expect(await sharesOf()).toEqual(['acc_ann>bob@2/MANUAL']);
    const row = await inTenant((tx) =>
      tx.prisma.recordShare.findFirstOrThrow({ where: { reason: 'MANUAL' } }),
    );
    expect(row.sourceId).toBe(NIL_UUID);
    expect(await inTenant((tx) => revokeManualShare(db(tx), share))).toBe(true);
    expect(await inTenant((tx) => revokeManualShare(db(tx), share))).toBe(false);
    expect(await sharesOf()).toEqual([]);
  });
});

describe('owner-based rules', () => {
  it.each<[string, Partial<SharingRuleDefinition>, string[]]>([
    ['a group (transitive users)', {}, ['acc_cat', 'acc_cat2']],
    ['exactly an org unit', { sourceType: 'ORG_UNIT', sourceId: undefined }, ['acc_ann']],
    [
      'an org unit and below',
      { sourceType: 'ORG_UNIT_AND_SUBORDINATES', sourceId: undefined },
      ['acc_ann', 'acc_bob'],
    ],
    ['one user', { sourceType: 'USER', sourceId: undefined }, ['acc_bob']],
    ['a queue’s users', { sourceType: 'QUEUE', sourceId: undefined }, ['acc_bob']],
  ])('share the records owned by %s', async (_, overrides, expected) => {
    const sourceId =
      overrides.sourceType === 'ORG_UNIT' || overrides.sourceType === 'ORG_UNIT_AND_SUBORDINATES'
        ? get('sales')
        : overrides.sourceType === 'USER'
          ? get('bob')
          : overrides.sourceType === 'QUEUE'
            ? get('q')
            : get('reps');
    const r = rule({ ...overrides, sourceId });
    await recalculateRule((fn) => inTenant((tx) => fn(db(tx))), {
      tenantId: T,
      rule: r,
      recordTable: 'fx_account',
    });
    expect(await sharesOf(r.id)).toEqual(expected.map((n) => `${n}>managers@1/RULE`).sort());
  });

  it('rejects an owner rule without a source', async () => {
    await expect(
      inTenant((tx) =>
        evaluateRulesForRecord(db(tx), {
          tenantId: T,
          recordTable: 'fx_account',
          recordId: get('acc_ann'),
          rules: [rule({ sourceType: null })],
        }),
      ),
    ).rejects.toThrow(/no source/);
  });
});

describe('criteria rules', () => {
  it('share the records matching the filter, and follow record changes', async () => {
    const r = rule({
      kind: 'CRITERIA',
      sourceType: null,
      sourceId: null,
      criteria: {
        and: [
          { field: 'amount', op: 'gte', value: 1000 },
          { field: 'name', op: 'starts_with', value: 'acc_' },
        ],
      },
      targetType: 'ORG_UNIT_AND_SUBORDINATES',
      targetId: get('sales'),
      access: 2,
    });
    await recalculateRule((fn) => inTenant((tx) => fn(db(tx))), {
      tenantId: T,
      rule: r,
      recordTable: 'fx_account',
    });
    expect(await sharesOf(r.id)).toEqual(['acc_bob>sales@2/RULE', 'acc_cat>sales@2/RULE']);

    // A record save re-evaluates the object's rules for that record only.
    await inTenant(async (tx) => {
      await tx.kysely
        .updateTable('fx_account')
        .set({ amount: 5 })
        .where('id', '=', get('acc_bob'))
        .execute();
      await tx.kysely
        .updateTable('fx_account')
        .set({ amount: 9999 })
        .where('id', '=', get('acc_ann'))
        .execute();
      for (const record of ['acc_bob', 'acc_ann'])
        await evaluateRulesForRecord(db(tx), {
          tenantId: T,
          recordTable: 'fx_account',
          recordId: get(record),
          rules: [r],
        });
    });
    expect(await sharesOf(r.id)).toEqual(['acc_ann>sales@2/RULE', 'acc_cat>sales@2/RULE']);
  });

  it('rejects malformed criteria', async () => {
    await expect(
      inTenant((tx) =>
        evaluateRulesForRecord(db(tx), {
          tenantId: T,
          recordTable: 'fx_account',
          recordId: get('acc_ann'),
          rules: [
            rule({ kind: 'CRITERIA', criteria: { field: 'amount', op: 'between', value: 1 } }),
          ],
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('recalculateRule', () => {
  it('works in batches, reports progress, and removes an inactive rule’s shares', async () => {
    const r = rule({});
    const progress: RecalculationProgress[] = [];
    let transactions = 0;
    const result = await recalculateRule(
      (fn) => {
        transactions += 1;
        return inTenant((tx) => fn(db(tx)));
      },
      {
        tenantId: T,
        rule: r,
        recordTable: 'fx_account',
        batchSize: 3,
        onProgress: (p) => Promise.resolve(void progress.push(p)),
      },
    );
    expect(result).toEqual({ done: 4, total: 4, written: 2 });
    expect(progress.map((p) => p.done)).toEqual([3, 4]);
    expect(transactions).toBe(3); // count + two batches

    await recalculateRule((fn) => inTenant((tx) => fn(db(tx))), {
      tenantId: T,
      rule: { ...r, active: false },
      recordTable: 'fx_account',
    });
    expect(await sharesOf(r.id)).toEqual([]);
  });

  it('handles an empty object and exact batch multiples', async () => {
    const r = rule({});
    const empty = await recalculateRule((fn) => inTenant((tx) => fn(db(tx))), {
      tenantId: T,
      rule: r,
      recordTable: 'fx_contact',
    });
    expect(empty).toEqual({ done: 0, total: 0, written: 0 });
    const exact = await recalculateRule((fn) => inTenant((tx) => fn(db(tx))), {
      tenantId: T,
      rule: r,
      recordTable: 'fx_account',
      batchSize: 2,
    });
    expect(exact).toMatchObject({ done: 4, total: 4 });
  });

  it('removes all of a deleted rule’s shares', async () => {
    expect(
      await inTenant((tx) =>
        removeRuleShares(db(tx), { tenantId: T, object: 'account', ruleId: get('rule') }),
      ),
    ).toBe(2);
    expect(await sharesOf(get('rule'))).toEqual([]);
  });

  it('refuses an unsafe table name', async () => {
    await expect(
      recalculateRule((fn) => inTenant((tx) => fn(db(tx))), {
        tenantId: T,
        rule: rule({}),
        recordTable: 'fx_account; drop',
      }),
    ).rejects.toThrow(/invalid table/);
  });
});

describe('stored rules', () => {
  it('enforce their shape in the database', async () => {
    const bad = [
      { kind: 'OWNER' as const, sourceType: null, sourceId: null },
      { kind: 'CRITERIA' as const, sourceType: 'GROUP' as const, sourceId: get('reps') },
      { kind: 'OWNER' as const, sourceType: 'GROUP' as const, sourceId: get('reps'), access: 3 },
      {
        kind: 'OWNER' as const,
        sourceType: 'GROUP' as const,
        sourceId: get('reps'),
        targetType: 'USER' as const,
      },
    ];
    for (const data of bad)
      await expect(
        withTenant(f.prisma, { tenantId: T }, ({ prisma }) =>
          prisma.sharingRule.create({
            data: {
              tenantId: T,
              object: 'account',
              name: `bad ${String(Math.random())}`,
              targetType: 'GROUP',
              targetId: get('managers'),
              access: 1,
              ...data,
            },
          }),
        ),
      ).rejects.toThrow(/sharing_rule_/);
  });
});
