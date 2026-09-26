import { principalsOf, visibility, type TenantTransaction } from '@sm/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  sharingPredicate,
  type AccessLevel,
  type ObjectSharing,
  type SharingContext,
  type SharingModel,
} from '../src/index.js';
import { createFixture, seedTenantSettings, type Fixture } from './fixtures.js';

const T = '01920000-0000-7000-8000-000000000b01';
const OTHER = '01920000-0000-7000-8000-000000000b02';

// Org: ceo > sales > emea.  Users: cara (ceo), sam (sales), eve + zed (emea peers), out (no unit).
// Group G = {out}. Queue Q = {eve}.
const id: Record<string, string> = {};
const get = (n: string) => {
  const v = id[n];
  if (!v) throw new Error(`no fixture ${n}`);
  return v;
};
let f: Fixture;

interface Options {
  models?: Partial<Record<string, SharingModel>>;
  hierarchy?: boolean;
  bypass?: (object: string, level: AccessLevel) => boolean;
}

async function context(
  tx: TenantTransaction,
  user: string,
  o: Options = {},
): Promise<SharingContext> {
  const principals = await principalsOf(tx, get(user));
  const table: Record<string, ObjectSharing> = {
    account: {
      object: 'account',
      table: 'fx_account',
      sharingModel: o.models?.['account'] ?? 'PRIVATE',
      grantHierarchy: o.hierarchy ?? true,
      parents: [{ field: 'parent_id', object: 'account' }],
    },
    contact: {
      object: 'contact',
      table: 'fx_contact',
      sharingModel: o.models?.['contact'] ?? 'CONTROLLED_BY_PARENT',
      grantHierarchy: true,
      parents: [{ field: 'account_id', object: 'account' }],
    },
    activity: {
      object: 'activity',
      table: 'fx_activity',
      sharingModel: 'CONTROLLED_BY_PARENT',
      grantHierarchy: true,
      parents: [
        { field: 'what_id', object: 'account' },
        { field: 'who_id', object: 'contact' },
      ],
    },
  };
  return {
    tenantId: T,
    principals,
    objectSharing: (object) => {
      const s = table[object];
      if (!s) throw new Error(object);
      return s;
    },
    bypasses: o.bypass ?? (() => false),
  };
}

async function visible(user: string, object: string, level: AccessLevel, o: Options = {}) {
  const tableName = { account: 'fx_account', contact: 'fx_contact', activity: 'fx_activity' }[
    object
  ];
  return f.inTenant(T, async (tx) => {
    const ctx = await context(tx, user, o);
    const rows = await tx.kysely
      .selectFrom(`${tableName ?? ''} as r`)
      .select('r.name')
      .where(() => sharingPredicate(ctx, object, 'r', level))
      .execute();
    return rows.map((r) => String(r['name'])).sort();
  });
}

beforeAll(async () => {
  f = await createFixture();
  await seedTenantSettings(f, T, 'pred');
  await f.inTenant(T, async (tx) => {
    const p = tx.prisma;
    let parent: string | null = null;
    for (const name of ['ceo', 'sales', 'emea']) {
      const u: { id: string } = await p.orgUnit.create({
        data: { tenantId: T, name, parentId: parent },
      });
      id[name] = u.id;
      parent = u.id;
    }
    for (const [name, unit] of [
      ['cara', 'ceo'],
      ['sam', 'sales'],
      ['eve', 'emea'],
      ['zed', 'emea'],
      ['out', null],
    ] as const) {
      const u = await p.user.create({
        data: { tenantId: T, email: `${name}@pred.test`, name, orgUnitId: unit ? get(unit) : null },
      });
      id[name] = u.id;
    }
    id['G'] = (await p.publicGroup.create({ data: { tenantId: T, name: 'G' } })).id;
    await p.groupMember.create({
      data: { tenantId: T, groupId: get('G'), memberType: 'USER', userId: get('out') },
    });
    id['Q'] = (await p.queue.create({ data: { tenantId: T, name: 'Q' } })).id;
    await p.queueMember.create({
      data: { tenantId: T, queueId: get('Q'), memberType: 'USER', userId: get('eve') },
    });
    await visibility.rebuild(tx);

    const account = async (name: string, owner: string, parentId?: string) => {
      const [row] = await tx.kysely
        .insertInto('fx_account')
        .values({ tenant_id: T, owner_id: get(owner), name, parent_id: parentId ?? null })
        .returning('id')
        .execute();
      id[name] = String(row?.['id']);
    };
    for (const [name, owner] of [
      ['a_eve', 'eve'],
      ['a_zed', 'zed'],
      ['a_sam', 'sam'],
      ['a_q', 'Q'],
      ['a_out', 'out'],
      ['a_x', 'out'],
    ] as const)
      await account(name, owner);
    await account('a_child', 'out', get('a_eve'));

    const share = (
      record: string,
      principalType: string,
      principal: string,
      access: number,
      reason = 'MANUAL',
    ) =>
      p.recordShare.create({
        data: {
          tenantId: T,
          object: 'account',
          recordId: get(record),
          principalType: principalType as never,
          principalId: get(principal),
          access,
          reason: reason as never,
          ...(reason === 'RULE' ? { sourceId: get('G') } : {}),
        },
      });
    await share('a_out', 'USER', 'eve', 1);
    await share('a_sam', 'GROUP', 'G', 2, 'RULE');
    await share('a_zed', 'ORG_UNIT_AND_SUBORDINATES', 'sales', 1, 'RULE');
    await share('a_x', 'ORG_UNIT', 'sales', 1, 'RULE');

    for (const [name, owner, accountName] of [
      ['c_eve', 'out', 'a_eve'],
      ['c_orphan', 'zed', null],
      ['c_child', 'out', 'a_child'],
    ] as const) {
      const [row] = await tx.kysely
        .insertInto('fx_contact')
        .values({
          tenant_id: T,
          owner_id: get(owner),
          name,
          account_id: accountName ? get(accountName) : null,
        })
        .returning('id')
        .execute();
      id[name] = String(row?.['id']);
    }
    await tx.kysely
      .insertInto('fx_activity')
      .values([
        {
          tenant_id: T,
          owner_id: get('cara'),
          name: 't_what_zed',
          what_id: get('a_zed'),
          who_id: null,
        },
        {
          tenant_id: T,
          owner_id: get('cara'),
          name: 't_who_c_eve',
          what_id: null,
          who_id: get('c_eve'),
        },
        { tenant_id: T, owner_id: get('zed'), name: 't_orphan', what_id: null, who_id: null },
        {
          tenant_id: T,
          owner_id: get('zed'),
          name: 't_deep',
          what_id: null,
          who_id: get('c_child'),
        },
      ])
      .execute();
  });
  await seedTenantSettings(f, OTHER, 'pred-other');
});

afterAll(async () => {
  await f.dispose();
});

describe('PRIVATE (§6.4 predicate)', () => {
  it.each<[string, AccessLevel, string[]]>([
    // own, queue, manual share to the user, and a "role and subordinates" share on sales
    ['eve', 'read', ['a_eve', 'a_out', 'a_q', 'a_zed']],
    // read-only shares do not give edit
    ['eve', 'edit', ['a_eve', 'a_q']],
    // hierarchy: users below; not a_x, which is shared with exactly the sales role
    ['cara', 'read', ['a_eve', 'a_sam', 'a_zed']],
    // own + below + the exact-role share on sales
    ['sam', 'read', ['a_eve', 'a_sam', 'a_x', 'a_zed']],
    // own records, and a Read-Write group share
    ['out', 'read', ['a_child', 'a_out', 'a_sam', 'a_x']],
    ['out', 'edit', ['a_child', 'a_out', 'a_sam', 'a_x']],
    // Full needs ownership, hierarchy or a Full share
    ['out', 'full', ['a_child', 'a_out', 'a_x']],
    // peers in one org unit do not see each other
    ['zed', 'read', ['a_zed']],
  ])('%s at %s sees %j', async (user, level, expected) => {
    expect(await visible(user, 'account', level)).toEqual(expected);
  });

  it('without hierarchy access, only ownership, queues and shares count', async () => {
    expect(await visible('cara', 'account', 'read', { hierarchy: false })).toEqual([]);
    expect(await visible('sam', 'account', 'read', { hierarchy: false })).toEqual([
      'a_sam',
      'a_x',
      'a_zed',
    ]);
    expect(await visible('eve', 'account', 'edit', { hierarchy: false })).toEqual(['a_eve', 'a_q']);
  });
});

describe('public models and bypasses (§6.3)', () => {
  const all = ['a_child', 'a_eve', 'a_out', 'a_q', 'a_sam', 'a_x', 'a_zed'];

  it('PUBLIC_READ opens reading only', async () => {
    const models = { account: 'PUBLIC_READ' as const };
    expect(await visible('zed', 'account', 'read', { models })).toEqual(all);
    expect(await visible('zed', 'account', 'edit', { models })).toEqual(['a_zed']);
  });

  it('PUBLIC_READ_WRITE opens editing, never Full', async () => {
    const models = { account: 'PUBLIC_READ_WRITE' as const };
    expect(await visible('zed', 'account', 'edit', { models })).toEqual(all);
    expect(await visible('zed', 'account', 'full', { models })).toEqual(['a_zed']);
  });

  it('View All / Modify All bypass sharing at the levels they cover', async () => {
    const bypass = (_: string, level: AccessLevel) => level === 'read';
    expect(await visible('zed', 'account', 'read', { bypass })).toEqual(all);
    expect(await visible('zed', 'account', 'edit', { bypass })).toEqual(['a_zed']);
  });
});

describe('CONTROLLED_BY_PARENT (§6.3)', () => {
  it('gives a contact the access its primary account gives', async () => {
    expect(await visible('eve', 'contact', 'read')).toEqual(['c_eve']);
    expect(await visible('zed', 'contact', 'read')).toEqual(['c_orphan']);
  });

  it('falls back to owner + hierarchy for a contact without an account (v1.3)', async () => {
    expect(await visible('cara', 'contact', 'read')).toEqual(['c_eve', 'c_orphan']);
    expect(await visible('out', 'contact', 'read')).toEqual(['c_child']);
  });

  it('follows any parent of an activity, through a contact to its account', async () => {
    expect(await visible('eve', 'activity', 'read')).toEqual(['t_what_zed', 't_who_c_eve']);
    expect(await visible('zed', 'activity', 'read')).toEqual(['t_orphan', 't_what_zed']);
    expect(await visible('cara', 'activity', 'read')).toEqual([
      't_orphan',
      't_what_zed',
      't_who_c_eve',
    ]);
  });

  it('checks the same level on the parent, and stops at the depth limit', async () => {
    expect(await visible('eve', 'contact', 'edit')).toEqual(['c_eve']);
    const models = { account: 'CONTROLLED_BY_PARENT' as const };
    // Accounts controlled by their parent account: a_child follows a_eve; the others are orphans.
    expect(await visible('eve', 'account', 'read', { models })).toEqual([
      'a_child',
      'a_eve',
      'a_out',
      'a_q',
      'a_zed',
    ]);
    expect(await visible('eve', 'contact', 'read', { models })).toEqual(['c_child', 'c_eve']);
    // t_deep needs activity → contact → a_child → a_eve: past MAX_PARENT_DEPTH, so it is denied.
    expect(await visible('eve', 'activity', 'read', { models })).toEqual([
      't_what_zed',
      't_who_c_eve',
    ]);
  });
});

describe('isolation', () => {
  it('never matches another tenant’s records or shares', async () => {
    const rows = await f.inTenant(OTHER, async (tx) => {
      const ctx: SharingContext = {
        tenantId: OTHER,
        principals: {
          userId: get('eve'),
          groupIds: [get('G')],
          queueIds: [get('Q')],
          orgUnitId: get('emea'),
          orgUnitAndAncestors: [get('sales')],
        },
        objectSharing: () => ({
          object: 'account',
          table: 'fx_account',
          sharingModel: 'PUBLIC_READ',
          grantHierarchy: true,
        }),
        bypasses: () => false,
      };
      return tx.kysely
        .selectFrom('fx_account as r')
        .select('r.name')
        .where(() => sharingPredicate(ctx, 'account', 'r', 'read'))
        .execute();
    });
    expect(rows).toEqual([]);
  });

  it('rejects an alias that is not a plain identifier', async () => {
    await f.inTenant(T, async (tx) => {
      const ctx = await context(tx, 'eve');
      expect(() => sharingPredicate(ctx, 'account', 'r; drop', 'read')).toThrow(/identifier/);
    });
  });
});
