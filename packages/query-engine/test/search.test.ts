import { principalsOf, visibility, type TenantTransaction } from '@sm/db';
import { effectivePermissions, type ObjectAccess } from '@sm/permissions';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  recentItems,
  recordViewed,
  search,
  SEARCH_FIELDS,
  searchTokens,
  type ObjectSharing,
  type QueryContext,
  type SearchInput,
} from '../src/index.js';
import { catalogueMetadata } from './catalogue-metadata.js';
import { createFixture, seedTenantSettings, type Fixture } from './fixtures.js';

const T = '01920000-0000-7000-8000-000000000c02';
const id: Record<string, string> = {};
const get = (n: string) => {
  const v = id[n];
  if (!v) throw new Error(`no fixture ${n}`);
  return v;
};
let f: Fixture;
const metadata = catalogueMetadata(['lead', 'account', 'contact']);
const ALL: ObjectAccess = {
  read: true,
  create: true,
  edit: true,
  delete: true,
  viewAll: false,
  modifyAll: false,
};
const LEAD_FIELDS = ['first_name', 'email', 'phone', 'mobile_phone', 'title', 'city', 'website'];

async function context(
  tx: TenantTransaction,
  user: string,
  options: { hidden?: string[]; noAccount?: boolean } = {},
): Promise<QueryContext> {
  const fields = (names: string[]) =>
    Object.fromEntries(
      names
        .filter((n) => !(options.hidden ?? []).includes(n))
        .map((n) => [n, { read: true, edit: true }]),
    );
  const permissions = effectivePermissions({
    profile: {
      system: [],
      objects: { lead: ALL, contact: ALL, ...(options.noAccount ? {} : { account: ALL }) },
      fields: {
        lead: fields(LEAD_FIELDS),
        contact: fields(['first_name', 'email', 'phone', 'account_id']),
        account: fields(['phone', 'website']),
      },
    },
    sets: [],
    groups: [],
  });
  const sharing: Record<string, ObjectSharing> = {
    lead: { object: 'lead', table: 'lead', sharingModel: 'PRIVATE', grantHierarchy: true },
    account: { object: 'account', table: 'account', sharingModel: 'PRIVATE', grantHierarchy: true },
    contact: { object: 'contact', table: 'contact', sharingModel: 'PRIVATE', grantHierarchy: true },
  };
  return {
    userId: get(user),
    metadata,
    permissions,
    maxLimit: 200,
    sharing: {
      tenantId: T,
      principals: await principalsOf(tx, get(user)),
      objectSharing: (o) => {
        const s = sharing[o];
        if (!s) throw new Error(o);
        return s;
      },
      bypasses: () => false,
    },
  };
}

const find = (user: string, input: SearchInput, options: Parameters<typeof context>[2] = {}) =>
  f.inTenant(T, async (tx) => search(tx.kysely, await context(tx, user, options), input));
const names = async (
  user: string,
  input: SearchInput,
  options: Parameters<typeof context>[2] = {},
) =>
  Object.fromEntries(
    (await find(user, input, options)).map((g) => [g.object, g.hits.map((h) => h.name)]),
  );

beforeAll(async () => {
  f = await createFixture();
  await seedTenantSettings(f, T, 'search');
  await f.inTenant(T, async (tx) => {
    const p = tx.prisma;
    for (const name of ['sam', 'sid']) {
      const u = await p.user.create({ data: { tenantId: T, email: `${name}@search.test`, name } });
      id[name] = u.id;
    }
    await visibility.rebuild(tx);
    const lead = async (
      first: string,
      last: string,
      extra: Record<string, unknown> = {},
      owner = 'sam',
    ) => {
      const row = await p.lead.create({
        data: {
          tenantId: T,
          recordNumber: `L-${last}`,
          ownerId: get(owner),
          firstName: first,
          lastName: last,
          company: 'Pixelcraft',
          status: 'open',
          currencyCode: 'USD',
          ...extra,
        },
      });
      id[last] = row.id;
    };
    await lead('Maya', 'Chen', {
      email: 'maya.chen@pixelcraft.example',
      phone: '+44 20 7946 0958',
    });
    await lead('Omar', 'Haddad', { title: 'Head of sales', city: 'Doha', company: 'Gulf Trading' });
    await lead('Priya', 'Nair', { mobilePhone: '+974 5550 1234', company: 'Pixelcraft Labs' });
    await lead('Secret', 'Person', { email: 'secret@pixelcraft.example' }, 'sid');
    await lead('Gone', 'Deleted', { deletedAt: new Date() });
    const account = await p.account.create({
      data: {
        tenantId: T,
        recordNumber: 'A-1',
        ownerId: get('sam'),
        name: 'Pixelcraft Studio',
        currencyCode: 'USD',
        phone: '+44 20 7946 0000',
      },
    });
    id['Pixelcraft Studio'] = account.id;
  });
});

afterAll(async () => {
  await f.dispose();
});

describe('search (§7.19)', () => {
  it('finds by name, email words, company and prefix, ranked, grouped by object', async () => {
    expect(await names('sam', { q: 'maya' })).toEqual({
      lead: ['Maya Chen'],
      contact: [],
      account: [],
    });
    expect(await names('sam', { q: 'pixel', objects: ['lead', 'account'] })).toEqual({
      lead: expect.arrayContaining(['Maya Chen', 'Priya Nair']) as unknown,
      account: ['Pixelcraft Studio'],
    });
    expect(await names('sam', { q: 'head sales', objects: ['lead'] })).toEqual({
      lead: ['Omar Haddad'],
    });
    const [group] = await find('sam', { q: 'chen', objects: ['lead'] });
    expect(group?.hits[0]).toMatchObject({
      id: get('Chen'),
      name: 'Maya Chen',
      matched: expect.arrayContaining(['last_name', 'email']) as unknown,
    });
  });

  it('tolerates typos in names', async () => {
    expect(await names('sam', { q: 'Hadad', objects: ['lead'] })).toEqual({
      lead: ['Omar Haddad'],
    });
    expect(await names('sam', { q: 'Pixlcraft Studio', objects: ['account'] })).toEqual({
      account: ['Pixelcraft Studio'],
    });
  });

  it('falls back to typo matching only when nothing matched exactly in any object', async () => {
    // An exact hit on the account: the near-matching leads are not offered.
    expect(await names('sam', { q: 'Pixelcraft Studio', objects: ['lead', 'account'] })).toEqual({
      lead: [],
      account: ['Pixelcraft Studio'],
    });
    // No exact hit anywhere ("Studo"): typo matching runs for every object.
    expect(await names('sam', { q: 'Pixelcraft Studo', objects: ['lead', 'account'] })).toEqual({
      lead: expect.arrayContaining(['Priya Nair']) as unknown,
      account: ['Pixelcraft Studio'],
    });
  });

  it('matches phone numbers by their last digits', async () => {
    expect(await names('sam', { q: '0958', objects: ['lead', 'account'] })).toEqual({
      lead: ['Maya Chen'],
      account: [],
    });
    expect(await names('sam', { q: '5550 1234', objects: ['lead'] })).toEqual({
      lead: ['Priya Nair'],
    });
  });

  it('never matches on, or reports, a field the caller cannot read', async () => {
    // Email is hidden: "maya.chen@…" words no longer find her by email alone.
    expect(await names('sam', { q: 'example', objects: ['lead'] }, { hidden: ['email'] })).toEqual({
      lead: [],
    });
    const [group] = await find('sam', { q: 'chen', objects: ['lead'] }, { hidden: ['email'] });
    expect(group?.hits[0]?.matched).toEqual(['last_name']);
    // Phones hidden: no suffix matching on them.
    expect(
      await names('sam', { q: '0958', objects: ['lead'] }, { hidden: ['phone', 'mobile_phone'] }),
    ).toEqual({ lead: [] });
    // First name hidden: trigram on names is off, the name shows without it.
    const typo = await names('sam', { q: 'Hadad', objects: ['lead'] }, { hidden: ['first_name'] });
    expect(typo).toEqual({ lead: [] });
    const [hidden] = await find(
      'sam',
      { q: 'haddad', objects: ['lead'] },
      { hidden: ['first_name'] },
    );
    expect(hidden?.hits[0]?.name).toBe('Haddad');
  });

  it('applies sharing, deletion, owner and date filters, and counts', async () => {
    expect(await names('sid', { q: 'pixelcraft', objects: ['lead'] })).toEqual({
      lead: ['Secret Person'],
    });
    expect(await names('sam', { q: 'gone', objects: ['lead'] })).toEqual({ lead: [] });
    expect(
      await names('sam', { q: 'pixelcraft', objects: ['account'] }, { noAccount: true }),
    ).toEqual({});
    expect(await names('sam', { q: 'pixelcraft', objects: ['lead'], ownerId: get('sid') })).toEqual(
      { lead: [] },
    );
    expect(
      await names('sam', {
        q: 'pixelcraft',
        objects: ['lead'],
        updatedSince: new Date(Date.now() + 60_000),
      }),
    ).toEqual({ lead: [] });
    const [counted] = await find('sam', {
      q: 'pixelcraft',
      objects: ['lead'],
      limit: 1,
      withTotals: true,
    });
    expect(counted).toMatchObject({ total: 2 });
    expect(counted?.hits).toHaveLength(1);
    expect(await find('sam', { q: '  !! ' })).toEqual([]);
    expect(searchTokens('Maya Chen, maya@x.io')).toEqual(['maya', 'chen', 'maya', 'x', 'io']);
  });
});

describe('SEARCH_FIELDS', () => {
  it('mirrors the search trigger of migration 0020 for every object', async () => {
    await f.inTenant(T, async (tx) => {
      for (const [object, spec] of Object.entries(SEARCH_FIELDS)) {
        const pieces = (['A', 'B', 'C'] as const).flatMap((w) => {
          const parts = spec.vector
            .filter(([, weight]) => weight === w)
            .map(([field, , kind]) =>
              kind === 'phone'
                ? sql`crm_search_phone(${sql.ref(`r.${field}`)})`
                : sql`crm_search_words(${sql.ref(`r.${field}`)})`,
            );
          return parts.length ? [sql`setweight(${sql.join(parts, sql` || `)}, ${w})`] : [];
        });
        const rows = await sql<{ same: boolean }>`
          SELECT r.search_vector = (${sql.join(pieces, sql` || `)}) AS same
            FROM ${sql.table(object)} AS r WHERE r.tenant_id = ${T}::uuid`.execute(tx.kysely);
        for (const row of rows.rows) expect(row.same, object).toBe(true);
      }
    });
  });
});

describe('recent items', () => {
  it('remembers what the caller opened, latest first, if they can still see it', async () => {
    await f.inTenant(T, async (tx) => {
      const ctx = await context(tx, 'sam');
      expect(await recordViewed(tx.kysely, ctx, 'lead', get('Nair'))).toBe(true);
      expect(await recordViewed(tx.kysely, ctx, 'account', get('Pixelcraft Studio'))).toBe(true);
      expect(await recordViewed(tx.kysely, ctx, 'lead', get('Person'))).toBe(false);
      expect(await recordViewed(tx.kysely, ctx, 'widget', get('Nair'))).toBe(false);
    });
    await new Promise((r) => setTimeout(r, 10));
    await f.inTenant(T, async (tx) => {
      const ctx = await context(tx, 'sam');
      await recordViewed(tx.kysely, ctx, 'lead', get('Nair'));
    });
    const items = await f.inTenant(T, async (tx) =>
      recentItems(tx.kysely, await context(tx, 'sam')),
    );
    expect(items.map((i) => `${i.object} ${String(i.name)}`)).toEqual([
      'lead Priya Nair',
      'account Pixelcraft Studio',
    ]);
    // Without account access, accounts drop out of the list.
    const fewer = await f.inTenant(T, async (tx) =>
      recentItems(tx.kysely, await context(tx, 'sam', { noAccount: true })),
    );
    expect(fewer.map((i) => i.object)).toEqual(['lead']);
  });
});
