import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  compileFilter,
  evaluateFilter,
  filterFields,
  parseFilter,
  type FilterNode,
} from '../src/index.js';
import { createFixture, type Fixture } from './fixtures.js';

/** Compiles queries without a database, to inspect the SQL. */
const compiler = new Kysely<Record<string, Record<string, unknown>>>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

describe('parseFilter', () => {
  it('accepts well-formed trees', () => {
    const f = parseFilter({
      and: [
        { field: 'name', op: 'contains', value: 'acme' },
        {
          or: [
            { field: 'amount', op: 'gte', value: 1000 },
            { field: 'active', op: 'is_null' },
          ],
        },
        { not: { field: 'name', op: 'in', value: ['x', 'y'] } },
      ],
    });
    expect(filterFields(f).sort()).toEqual(['active', 'amount', 'name']);
  });

  it.each([
    ['an unknown operator', { field: 'name', op: 'like', value: 'x' }],
    ['a field that is not an API name', { field: 'name; DROP TABLE x', op: 'eq', value: 1 }],
    ['an empty group', { and: [] }],
    ['an empty list', { field: 'name', op: 'in', value: [] }],
    ['extra keys on a group', { and: [{ field: 'a', op: 'is_null' }], or: [] }],
    ['an object value', { field: 'name', op: 'eq', value: { $gt: 1 } }],
  ])('rejects %s', (_, input) => {
    expect(() => parseFilter(input)).toThrow();
  });

  it('caps depth and size', () => {
    let deep: FilterNode = { field: 'name', op: 'is_null' };
    for (let i = 0; i < 8; i += 1) deep = { not: deep };
    expect(() => parseFilter(deep)).toThrow(/8 levels/);
    const wide = {
      or: Array.from({ length: 3 }, () => ({
        and: Array.from({ length: 40 }, () => ({ field: 'name', op: 'is_null' })),
      })),
    };
    expect(() => parseFilter(wide)).toThrow(/100 conditions/);
  });
});

describe('evaluateFilter (SQL semantics)', () => {
  const row = { name: 'Acme Ltd', amount: 5000, active: null, closed_on: new Date('2026-03-01') };
  it.each<[FilterNode, boolean]>([
    [{ field: 'name', op: 'eq', value: 'Acme Ltd' }, true],
    [{ field: 'name', op: 'contains', value: 'ACME' }, true],
    [{ field: 'name', op: 'starts_with', value: 'ltd' }, false],
    [{ field: 'amount', op: 'gt', value: 4999 }, true],
    [{ field: 'amount', op: 'lte', value: 4999 }, false],
    [{ field: 'active', op: 'eq', value: true }, false],
    [{ field: 'active', op: 'ne', value: true }, false], // NULL <> true is unknown
    [{ not: { field: 'active', op: 'eq', value: true } }, false], // NOT unknown is unknown
    [{ field: 'active', op: 'is_null' }, true],
    [{ field: 'missing', op: 'is_not_null' }, false],
    [{ field: 'closed_on', op: 'lt', value: '2026-04-01' }, true],
    [{ field: 'amount', op: 'not_in', value: [1, 2] }, true],
    [
      {
        or: [
          { field: 'active', op: 'eq', value: true },
          { field: 'amount', op: 'eq', value: 5000 },
        ],
      },
      true,
    ],
    [
      {
        and: [
          { field: 'active', op: 'eq', value: true },
          { field: 'amount', op: 'eq', value: 5000 },
        ],
      },
      false,
    ],
  ])('%j → %s', (filter, expected) => {
    expect(evaluateFilter(filter, row)).toBe(expected);
  });
});

describe('compileFilter agrees with evaluateFilter on Postgres', () => {
  let f: Fixture;
  const tenantId = '01920000-0000-7000-8000-000000000a01';
  const owner = '01920000-0000-7000-8000-000000000a02';
  const rows = [
    { name: 'Acme Ltd', amount: 5000, closed_on: '2026-03-01', active: true },
    { name: 'acme 100%_off', amount: null, closed_on: null, active: false },
    { name: 'Globex', amount: 150.5, closed_on: '2025-12-31', active: null },
    { name: 'Initech', amount: 0, closed_on: '2026-06-30', active: true },
  ];

  beforeAll(async () => {
    f = await createFixture();
    await f.inTenant(tenantId, (tx) =>
      tx.kysely
        .insertInto('fx_account')
        .values(rows.map((r) => ({ tenant_id: tenantId, owner_id: owner, ...r })))
        .execute(),
    );
  });

  afterAll(async () => {
    await f.dispose();
  });

  const filters: FilterNode[] = [
    { field: 'name', op: 'contains', value: 'acme' },
    { field: 'name', op: 'contains', value: '100%_' },
    { field: 'name', op: 'starts_with', value: 'glo' },
    { field: 'amount', op: 'gte', value: 150.5 },
    { field: 'amount', op: 'ne', value: 0 },
    { field: 'amount', op: 'is_null' },
    { field: 'active', op: 'eq', value: true },
    { not: { field: 'active', op: 'eq', value: true } },
    { field: 'active', op: 'is_not_null' },
    { field: 'closed_on', op: 'lt', value: '2026-04-01' },
    { field: 'name', op: 'in', value: ['Globex', 'Initech'] },
    { field: 'name', op: 'not_in', value: ['Globex'] },
    {
      or: [
        {
          and: [
            { field: 'amount', op: 'gt', value: 100 },
            { field: 'active', op: 'eq', value: true },
          ],
        },
        { field: 'closed_on', op: 'is_null' },
      ],
    },
  ];

  it.each(filters.map((filter) => [JSON.stringify(filter), filter] as const))(
    '%s',
    async (_, filter) => {
      const fromSql = await f.inTenant(tenantId, (tx) =>
        tx.kysely
          .selectFrom('fx_account as r')
          .select('r.name')
          .where((eb) => compileFilter(eb, 'r', filter))
          .execute(),
      );
      const inMemory = rows
        .map((r) => ({ ...r, closed_on: r.closed_on ? new Date(r.closed_on) : null }))
        .filter((r) => evaluateFilter(filter, r))
        .map((r) => r.name)
        .sort();
      expect(fromSql.map((r) => String(r['name'])).sort()).toEqual(inMemory);
    },
  );

  it('binds values as parameters, never inlines them', () => {
    const compiled = compiler
      .selectFrom('fx_account as r')
      .select('r.name')
      .where((eb) => compileFilter(eb, 'r', { field: 'name', op: 'eq', value: "x' OR '1'='1" }))
      .compile();
    expect(compiled.sql).toBe('select "r"."name" from "fx_account" as "r" where "r"."name" = $1');
    expect(compiled.parameters).toEqual(["x' OR '1'='1"]);
  });
});
