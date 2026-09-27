import { principalsOf, visibility, type TenantTransaction } from '@sm/db';
import type { ObjectAccess } from '@sm/permissions';
import { effectivePermissions, type EffectivePermissions } from '@sm/permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  countQuery,
  QueryError,
  runQuery,
  type ObjectSharing,
  type QueryContext,
  type QueryPage,
  type Smq,
} from '../src/index.js';
import { catalogueMetadata } from './catalogue-metadata.js';
import { createFixture, seedTenantSettings, type Fixture } from './fixtures.js';

const T = '01920000-0000-7000-8000-000000000c01';
const id: Record<string, string> = {};
const get = (n: string) => {
  const v = id[n];
  if (!v) throw new Error(`no fixture ${n}`);
  return v;
};
let f: Fixture;

const metadata = catalogueMetadata(['lead', 'account', 'contact'], {
  lead: [
    { apiName: 'tier__c', type: 'picklist' },
    { apiName: 'score__c', type: 'number' },
    { apiName: 'region__c', type: 'text', required: true },
  ],
});

const ALL: ObjectAccess = {
  read: true,
  create: true,
  edit: true,
  delete: true,
  viewAll: false,
  modifyAll: false,
};
const leadFields = (hidden: string[] = []) =>
  Object.fromEntries(
    [
      'first_name',
      'email',
      'phone',
      'city',
      'annual_revenue',
      'description',
      'tier__c',
      'score__c',
      'campaign_id',
      'do_not_call',
    ]
      .filter((n) => !hidden.includes(n))
      .map((n) => [n, { read: true, edit: true }]),
  );
function permissions(
  options: { hidden?: string[]; viewAll?: boolean; noAccount?: boolean } = {},
): EffectivePermissions {
  return effectivePermissions({
    profile: {
      system: options.viewAll ? ['view_all_data'] : [],
      objects: { lead: ALL, contact: ALL, ...(options.noAccount ? {} : { account: ALL }) },
      fields: {
        lead: leadFields(options.hidden),
        contact: { account_id: { read: true, edit: true }, email: { read: true, edit: true } },
        account: { industry: { read: true, edit: true } },
      },
    },
    sets: [],
    groups: [],
  });
}

async function context(
  tx: TenantTransaction,
  user: string,
  options: Parameters<typeof permissions>[0] = {},
  maxLimit = 200,
): Promise<QueryContext> {
  const perms = permissions(options);
  const sharing: Record<string, ObjectSharing> = {
    lead: { object: 'lead', table: 'lead', sharingModel: 'PRIVATE', grantHierarchy: true },
    account: { object: 'account', table: 'account', sharingModel: 'PRIVATE', grantHierarchy: true },
    // Private here (not Controlled by Parent) so a contact can be visible while its account is not.
    contact: { object: 'contact', table: 'contact', sharingModel: 'PRIVATE', grantHierarchy: true },
  };
  return {
    userId: get(user),
    metadata,
    permissions: perms,
    maxLimit,
    sharing: {
      tenantId: T,
      principals: await principalsOf(tx, get(user)),
      objectSharing: (o) => {
        const s = sharing[o];
        if (!s) throw new Error(o);
        return s;
      },
      bypasses: () => Boolean(options.viewAll),
    },
  };
}

const query = (
  user: string,
  q: Smq,
  options: Parameters<typeof permissions>[0] = {},
  maxLimit = 200,
) =>
  f.inTenant(T, async (tx) => runQuery(tx.kysely, q, await context(tx, user, options, maxLimit)));
const names = (page: QueryPage) => page.records.map((r) => r['last_name'] ?? r['name']);

/** Every page of a query, following cursors. */
async function allPages(user: string, q: Smq, options: Parameters<typeof permissions>[0] = {}) {
  const seen: unknown[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i += 1) {
    const page = await query(user, { ...q, ...(cursor ? { cursor } : {}) }, options);
    seen.push(...page.records.map((r) => r['last_name']));
    if (!page.nextCursor) return seen;
    cursor = page.nextCursor;
  }
  throw new Error('too many pages');
}

beforeAll(async () => {
  f = await createFixture();
  await seedTenantSettings(f, T, 'smq');
  await f.inTenant(T, async (tx) => {
    const p = tx.prisma;
    // ceo > sales; cara (ceo) sees sam's records; sam and sid are peers; eve has no unit.
    let parent: string | null = null;
    for (const name of ['ceo', 'sales']) {
      const u: { id: string } = await p.orgUnit.create({
        data: { tenantId: T, name, parentId: parent },
      });
      id[name] = u.id;
      parent = u.id;
    }
    for (const [name, unit] of [
      ['cara', 'ceo'],
      ['sam', 'sales'],
      ['sid', 'sales'],
      ['eve', null],
    ] as const) {
      const u = await p.user.create({
        data: { tenantId: T, email: `${name}@smq.test`, name, orgUnitId: unit ? get(unit) : null },
      });
      id[name] = u.id;
    }
    await visibility.rebuild(tx);

    const lead = async (
      last: string,
      owner: string,
      extra: {
        first?: string | null;
        city?: string | null;
        revenue?: string | null;
        email?: string;
        created?: string;
        custom?: object;
        deleted?: boolean;
      } = {},
    ) => {
      const row = await p.lead.create({
        data: {
          tenantId: T,
          recordNumber: `L-${last}`,
          ownerId: get(owner),
          lastName: last,
          firstName: extra.first ?? null,
          company: `${last} Co`,
          status: 'open',
          currencyCode: 'USD',
          city: extra.city ?? null,
          annualRevenue: extra.revenue ?? null,
          email: extra.email ?? null,
          custom: extra.custom ?? {},
          ...(extra.created ? { createdAt: new Date(extra.created) } : {}),
          ...(extra.deleted ? { deletedAt: new Date() } : {}),
        },
      });
      id[last] = row.id;
    };
    await lead('Adams', 'sam', {
      city: 'Doha',
      revenue: '100.00',
      email: 'adams@x.example',
      custom: { tier__c: 'gold', score__c: 7 },
    });
    await lead('Baker', 'sam', {
      city: null,
      revenue: '250.50',
      custom: { tier__c: 'silver', score__c: 3 },
    });
    await lead('Clark', 'sid', { city: 'Dubai', revenue: null, custom: { tier__c: 'gold' } });
    await lead('Davis', 'cara', { city: 'Doha', revenue: '100.00' });
    await lead('Evans', 'eve', { city: null, first: 'Eve' });
    await lead('Gone', 'sam', { deleted: true });

    const account = async (name: string, owner: string) => {
      const row = await p.account.create({
        data: {
          tenantId: T,
          recordNumber: `A-${name}`,
          ownerId: get(owner),
          name,
          currencyCode: 'USD',
          industry: 'banking',
        },
      });
      id[name] = row.id;
    };
    await account('Acme', 'sam');
    await account('Secret', 'eve');
    const contact = async (last: string, owner: string, accountName: string | null) => {
      const row = await p.contact.create({
        data: {
          tenantId: T,
          recordNumber: `C-${last}`,
          ownerId: get(owner),
          lastName: last,
          accountId: accountName ? get(accountName) : null,
        },
      });
      id[last] = row.id;
    };
    await contact('Ivy', 'sam', 'Acme');
    await contact('Jay', 'sam', 'Secret'); // sam owns the contact, not its account
    await contact('Kim', 'sam', null);

    await p.recentItem.createMany({
      data: [
        {
          tenantId: T,
          userId: get('sam'),
          object: 'lead',
          recordId: get('Baker'),
          viewedAt: new Date('2026-09-02'),
        },
        {
          tenantId: T,
          userId: get('sam'),
          object: 'lead',
          recordId: get('Adams'),
          viewedAt: new Date('2026-09-03'),
        },
        {
          tenantId: T,
          userId: get('sam'),
          object: 'lead',
          recordId: get('Clark'),
          viewedAt: new Date('2026-09-01'),
        },
      ],
    });
  });
});

afterAll(async () => {
  await f.dispose();
});

describe('runQuery: sharing and pagination', () => {
  it('shows each user exactly what sharing allows, never deleted records', async () => {
    const q: Smq = {
      object: 'lead',
      fields: ['last_name'],
      orderBy: [{ field: 'last_name', direction: 'asc' }],
    };
    expect(names(await query('sam', q))).toEqual(['Adams', 'Baker']);
    expect(names(await query('cara', q))).toEqual(['Adams', 'Baker', 'Clark', 'Davis']);
    expect(names(await query('eve', q))).toEqual(['Evans']);
    expect(names(await query('eve', q, { viewAll: true }))).toEqual([
      'Adams',
      'Baker',
      'Clark',
      'Davis',
      'Evans',
    ]);
  });

  it('pages through every row exactly once with nulls last ascending and first descending', async () => {
    const admin = { viewAll: true };
    const byCityAsc = await allPages(
      'eve',
      {
        object: 'lead',
        fields: ['last_name', 'city'],
        orderBy: [{ field: 'city', direction: 'asc' }],
        limit: 2,
      },
      admin,
    );
    // Doha (Adams, Davis by id), Dubai, then the blank cities last (Baker, Evans by id).
    expect(byCityAsc).toEqual(['Adams', 'Davis', 'Clark', 'Baker', 'Evans']);
    const byCityDesc = await allPages(
      'eve',
      {
        object: 'lead',
        fields: ['last_name'],
        orderBy: [{ field: 'city', direction: 'desc' }],
        limit: 1,
      },
      admin,
    );
    expect(byCityDesc).toHaveLength(5);
    expect(new Set(byCityDesc).size).toBe(5);
    expect(byCityDesc.slice(0, 2).sort()).toEqual(['Baker', 'Evans']); // nulls first when descending
    expect(byCityDesc.at(-1)).toMatch(/Adams|Davis/);
    const byRevenue = await allPages(
      'eve',
      {
        object: 'lead',
        fields: ['last_name'],
        orderBy: [
          { field: 'annual_revenue', direction: 'desc' },
          { field: 'last_name', direction: 'asc' },
        ],
        limit: 2,
      },
      admin,
    );
    expect(byRevenue).toEqual(['Clark', 'Evans', 'Baker', 'Adams', 'Davis']);
  });

  it('shows recently viewed records, latest first', async () => {
    const page = await query('sam', { object: 'lead', fields: ['last_name'], scope: 'recent' });
    // Clark is not visible to sam, so the view never mentions it.
    expect(names(page)).toEqual(['Adams', 'Baker']);
  });

  it('counts matching records', async () => {
    const count = await f.inTenant(T, async (tx) =>
      countQuery(tx.kysely, { object: 'lead', fields: ['last_name'] }, await context(tx, 'cara')),
    );
    expect(count).toEqual({ count: 4, capped: false });
  });
});

describe('runQuery: fields, filters and field-level security', () => {
  it('returns typed values: exact decimals, dates as text, custom fields by key', async () => {
    const page = await query('sam', {
      object: 'lead',
      fields: ['last_name', 'annual_revenue', 'created_at', 'tier__c', 'score__c', 'do_not_call'],
      orderBy: [{ field: 'last_name', direction: 'asc' }],
    });
    expect(page.records[0]).toMatchObject({
      id: get('Adams'),
      last_name: 'Adams',
      annual_revenue: '100.00',
      tier__c: 'gold',
      score__c: '7',
      do_not_call: false,
    });
    expect(String(page.records[0]?.['created_at'])).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
    );
  });

  it('filters on standard and custom fields, $me, and in/null conditions', async () => {
    const run = (where: Smq['where'], user = 'cara') =>
      query(user, {
        object: 'lead',
        fields: ['last_name'],
        where,
        orderBy: [{ field: 'last_name', direction: 'asc' }],
      }).then(names);
    expect(await run({ field: 'tier__c', op: 'eq', value: 'gold' })).toEqual(['Adams', 'Clark']);
    expect(await run({ field: 'score__c', op: 'gt', value: 5 })).toEqual(['Adams']);
    expect(await run({ field: 'annual_revenue', op: 'gte', value: '200' })).toEqual(['Baker']);
    expect(await run({ field: 'city', op: 'is_null' })).toEqual(['Baker']);
    expect(await run({ field: 'city', op: 'in', value: ['Doha', 'Dubai'] })).toEqual([
      'Adams',
      'Clark',
      'Davis',
    ]);
    expect(await run({ field: 'owner_id', op: 'eq', value: '$me' })).toEqual(['Davis']);
    expect(
      await run({
        and: [
          { field: 'city', op: 'eq', value: 'Doha' },
          { not: { field: 'last_name', op: 'starts_with', value: 'd' } },
        ],
      }),
    ).toEqual(['Adams']);
  });

  it('leaves hidden fields out of results and refuses them in filters and sorts', async () => {
    const hidden = { hidden: ['email', 'score__c'] };
    const page = await query(
      'sam',
      { object: 'lead', fields: ['last_name', 'email', 'score__c', 'region__c'] },
      hidden,
    );
    expect(Object.keys(page.records[0] ?? {}).sort()).toEqual(['id', 'last_name', 'region__c']);
    await expect(
      query(
        'sam',
        { object: 'lead', fields: ['last_name'], where: { field: 'email', op: 'is_not_null' } },
        hidden,
      ),
    ).rejects.toMatchObject({ code: 'field_not_readable', field: 'email' });
    await expect(
      query(
        'sam',
        {
          object: 'lead',
          fields: ['last_name'],
          orderBy: [{ field: 'score__c', direction: 'asc' }],
        },
        hidden,
      ),
    ).rejects.toMatchObject({ code: 'field_not_readable' });
  });

  it('follows lookups, naming only records the reader may see', async () => {
    const page = await query('sam', {
      object: 'contact',
      fields: ['last_name', 'account_id', 'account.industry', 'owner_id'],
      orderBy: [{ field: 'last_name', direction: 'asc' }],
    });
    const byName = new Map(page.records.map((r) => [r['last_name'], r]));
    expect(byName.get('Ivy')).toMatchObject({
      account_id: { id: get('Acme'), name: 'Acme', object: 'account' },
      'account.industry': 'banking',
      owner_id: { id: get('sam'), name: 'sam', object: 'user' },
    });
    // Jay's account belongs to eve: sam sees the contact (he owns it) but not the account's name.
    expect(byName.get('Jay')).toMatchObject({
      account_id: { id: get('Secret'), name: null },
      'account.industry': null,
    });
    expect(byName.get('Kim')).toMatchObject({ account_id: null });
    const filtered = await query('sam', {
      object: 'contact',
      fields: ['last_name'],
      where: { field: 'account.name', op: 'eq', value: 'Acme' },
    });
    expect(names(filtered)).toEqual(['Ivy']);
  });

  it('refuses what is not allowed or not valid', async () => {
    const bad = async (q: unknown, code: string, options = {}, maxLimit = 200) =>
      expect(query('sam', q as Smq, options, maxLimit)).rejects.toMatchObject({ code });
    await bad({ object: 'nope', fields: ['x'] }, 'unknown_object');
    await bad({ object: 'account', fields: ['name'] }, 'unknown_object', { noAccount: true });
    await bad({ object: 'lead', fields: ['nope'] }, 'unknown_field');
    await bad(
      { object: 'lead', fields: ['last_name'], where: { field: 'nope', op: 'is_null' } },
      'unknown_field',
    );
    await bad(
      {
        object: 'lead',
        fields: ['last_name'],
        orderBy: [{ field: 'description', direction: 'asc' }],
      },
      'not_sortable',
    );
    await bad({ object: 'lead', fields: ['last_name'], cursor: 'garbage' }, 'invalid_cursor');
    await bad({ object: 'lead', fields: ['last_name'], limit: 500 }, 'limit_too_high');
    await bad(
      { object: 'lead', fields: ['last_name'], where: { field: 'x', op: 'bogus' } },
      'invalid_filter',
    );
    await bad({ object: 'lead', fields: ['last_name'], extra: 1 }, 'invalid_filter');
    await bad({ object: 'contact', fields: ['account.nope.name'] }, 'unknown_field');
    expect(new QueryError('unknown_field', 'x').message).toBe('unknown_field: x');
    expect(new QueryError('invalid_cursor').message).toBe('invalid_cursor');
  });
});
