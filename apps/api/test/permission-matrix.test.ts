/**
 * The P01 exit-gate permission matrix (T15): table-driven cases over fixture object tables and a
 * generated org hierarchy, covering every §6.2 layer (object, record, field), org-wide defaults,
 * hierarchy, public groups (nested), queues, owner and criteria rules, manual shares, parent
 * control, View/Modify All, muting and FLS. Each case asserts the AccessService decision; the
 * row-set cases assert which rows the sharing predicate itself returns.
 */
import { withTenant, type CellPrisma, type TenantTransaction } from '@sm/db';
import { hasSystemPermission } from '@sm/permissions';
import {
  grantManualShare,
  recalculateRule,
  sharingPredicate,
  type AccessLevel,
  type SharingRuleDefinition,
} from '@sm/query-engine';
import { makeTenantWithHierarchy, type TenantHierarchy } from '@sm/testing';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AccessService,
  type DeniedLayer,
  type RecordAction,
} from '../src/access/access.service.js';
import { provisionDefaultProfiles, writeGrants } from '../src/permissions/default-profiles.js';
import { provisionOrgWideDefaults } from '../src/sharing/sharing.service.js';
import { PRISMA } from '../src/tokens.js';
import { startTestApi, type TestApi } from './support.js';

let api: TestApi;
let prisma: CellPrisma;
let access: AccessService;
let h: TenantHierarchy;
let other: TenantHierarchy;
/** Every named fixture (users, records, groups, queue) → its id. */
const ids = new Map<string, string>();
const id = (key: string) => {
  const v = ids.get(key);
  if (!v) throw new Error(`no fixture ${key}`);
  return v;
};
const inTenant = <T>(fn: (tx: TenantTransaction) => Promise<T>, tenantId = h.tenantId) =>
  withTenant(prisma, { tenantId }, fn);

type FixtureObject = 'account' | 'contact' | 'lead' | 'campaign' | 'opportunity';
const NONE = {
  read: false,
  create: false,
  edit: false,
  delete: false,
  viewAll: false,
  modifyAll: false,
};

/** The users outside the generated tree, each isolating one layer. */
const EXTRA_USERS = ['admin', 'ro', 'minimal', 'auditor', 'muted', 'gone'] as const;

async function insert(
  tx: TenantTransaction,
  object: string,
  key: string,
  row: Record<string, unknown>,
) {
  const [created] = await tx.kysely
    .insertInto(`fx_${object}`)
    .values({ tenant_id: h.tenantId, ...row })
    .returning('id')
    .execute();
  ids.set(key, String(created?.['id']));
}

beforeAll(async () => {
  api = await startTestApi({}, { recordTables: (object) => `fx_${object}` });
  prisma = api.app.get<symbol, CellPrisma>(PRISMA);
  access = api.app.get(AccessService);
  const migrator = new pg.Client({ connectionString: api.db.migratorUrl });
  await migrator.connect();
  const columns: Record<FixtureObject, string> = {
    account: 'name text NOT NULL, industry text, website text, annual_revenue numeric',
    contact: 'last_name text NOT NULL, account_id uuid',
    lead: 'last_name text NOT NULL',
    campaign: 'name text NOT NULL',
    opportunity: 'name text NOT NULL',
  };
  for (const [object, cols] of Object.entries(columns))
    await migrator.query(`
      CREATE TABLE fx_${object} (tenant_id uuid NOT NULL,
        id uuid NOT NULL DEFAULT uuid_generate_v7(), owner_id uuid NOT NULL, ${cols},
        PRIMARY KEY (tenant_id, id));
      SELECT enable_tenant_rls('fx_${object}');`);
  await migrator.end();

  h = await makeTenantWithHierarchy(prisma, { depth: 2, usersPerUnit: 2, slug: 'matrix' });
  other = await makeTenantWithHierarchy(prisma, { depth: 0, usersPerUnit: 1, slug: 'elsewhere' });
  for (const u of h.users) ids.set(u.name, u.id);
  const { tenantId } = h;

  await inTenant(async (tx) => {
    const p = tx.prisma;
    const profiles = await provisionDefaultProfiles(tx, tenantId, 'en');
    await provisionOrgWideDefaults(tx);
    await p.orgWideDefault.update({
      where: { tenantId_object: { tenantId, object: 'lead' } },
      data: { sharingModel: 'PUBLIC_READ' },
    });
    await p.orgWideDefault.update({
      where: { tenantId_object: { tenantId, object: 'campaign' } },
      data: { sharingModel: 'PUBLIC_READ_WRITE' },
    });
    await p.user.updateMany({ data: { profileId: profiles.standard_user } });

    // "Minimal": account read/edit only; FLS: industry editable, website read-only, revenue hidden.
    const minimalSet = await p.permissionSet.create({
      data: { tenantId, kind: 'PROFILE', name: 'Minimal' },
    });
    await writeGrants(tx, tenantId, minimalSet.id, {
      system: [],
      objects: { account: { ...NONE, read: true, edit: true } },
      fields: {
        account: {
          industry: { read: true, edit: true },
          website: { read: true, edit: false },
          annual_revenue: { read: false, edit: false },
        },
      },
    });
    const minimal = await p.profile.create({
      data: { tenantId, name: 'Minimal', permissionSetId: minimalSet.id },
    });
    const profileOf: Record<(typeof EXTRA_USERS)[number], string> = {
      admin: profiles.system_administrator,
      ro: profiles.read_only,
      minimal: minimal.id,
      auditor: profiles.standard_user,
      muted: minimal.id,
      gone: profiles.standard_user,
    };
    for (const name of EXTRA_USERS) {
      const user = await p.user.create({
        data: {
          tenantId,
          email: `${name}@matrix.test`,
          name,
          status: 'ACTIVE',
          emailVerifiedAt: new Date(),
          profileId: profileOf[name],
          deactivatedAt: name === 'gone' ? new Date() : null,
        },
      });
      ids.set(name, user.id);
    }

    // auditor: View All on accounts through a permission set.
    const viewAll = await p.permissionSet.create({ data: { tenantId, name: 'Account auditor' } });
    await writeGrants(tx, tenantId, viewAll.id, {
      system: [],
      objects: { account: { ...NONE, read: true, viewAll: true } },
      fields: {},
    });
    await p.permissionAssignment.create({
      data: { tenantId, userId: id('auditor'), permissionSetId: viewAll.id },
    });

    // muted: a group granting full account access and export_reports, muting delete and export.
    const fullAccounts = await p.permissionSet.create({ data: { tenantId, name: 'Accounts' } });
    await writeGrants(tx, tenantId, fullAccounts.id, {
      system: ['export_reports'],
      objects: { account: { ...NONE, read: true, create: true, edit: true, delete: true } },
      fields: {},
    });
    const muting = await p.permissionSet.create({
      data: { tenantId, kind: 'MUTING', name: 'no delete' },
    });
    await writeGrants(tx, tenantId, muting.id, {
      system: ['export_reports'],
      objects: { account: { ...NONE, delete: true } },
      fields: {},
    });
    const group = await p.permissionSetGroup.create({
      data: { tenantId, name: 'Account desk', mutingSetId: muting.id },
    });
    await p.permissionSetGroupMember.create({
      data: { tenantId, groupId: group.id, permissionSetId: fullAccounts.id },
    });
    await p.permissionAssignment.create({
      data: { tenantId, userId: id('muted'), permissionSetGroupId: group.id },
    });

    // Public groups: "inner" = {U.1.0#1}; "outer" = {inner}.
    const inner = await p.publicGroup.create({ data: { tenantId, name: 'inner' } });
    await p.groupMember.create({
      data: { tenantId, groupId: inner.id, memberType: 'USER', userId: id('U.1.0#1') },
    });
    const outer = await p.publicGroup.create({ data: { tenantId, name: 'outer' } });
    await p.groupMember.create({
      data: { tenantId, groupId: outer.id, memberType: 'GROUP', memberGroupId: inner.id },
    });
    ids.set('group:outer', outer.id);

    // A lead queue with U.1#1 in it.
    const queue = await p.queue.create({ data: { tenantId, name: 'Inbound' } });
    await p.queueObject.create({ data: { tenantId, queueId: queue.id, object: 'lead' } });
    await p.queueMember.create({
      data: { tenantId, queueId: queue.id, memberType: 'USER', userId: id('U.1#1') },
    });
    ids.set('queue', queue.id);

    // Records.
    for (const u of h.users)
      await insert(tx, 'opportunity', `opp:${u.name}`, { owner_id: u.id, name: u.name });
    await insert(tx, 'account', 'acc:energy', {
      owner_id: id('U.1.1#1'),
      name: 'Energy Co',
      industry: 'Energy',
    });
    await insert(tx, 'account', 'acc:u000', {
      owner_id: id('U.0.0#1'),
      name: 'Retail Co',
      industry: 'Retail',
    });
    await insert(tx, 'account', 'acc:manual', { owner_id: id('U.0.1#1'), name: 'Manual Co' });
    await insert(tx, 'account', 'acc:minimal', { owner_id: id('minimal'), name: 'Minimal Co' });
    await insert(tx, 'account', 'acc:muted', { owner_id: id('muted'), name: 'Muted Co' });
    await insert(tx, 'contact', 'con:energy', {
      owner_id: id('U.1.1#1'),
      last_name: 'Volt',
      account_id: id('acc:energy'),
    });
    await insert(tx, 'contact', 'con:orphan', { owner_id: id('U.0#1'), last_name: 'Alone' });
    await insert(tx, 'lead', 'lead:u00', { owner_id: id('U.0.0#0'), last_name: 'Prospect' });
    await insert(tx, 'lead', 'lead:queue', { owner_id: id('queue'), last_name: 'Unassigned' });
    await insert(tx, 'campaign', 'camp:1', { owner_id: id('U#0'), name: 'Launch' });
    await tx.prisma.$queryRaw`SELECT rebuild_user_visibility(NULL)`;

    // Manual shares on acc:manual: U.1.0#0 read; U.1.1 and below read-write.
    for (const [principal, level] of [
      [{ type: 'USER' as const, id: id('U.1.0#0') }, 1 as const],
      [{ type: 'ORG_UNIT_AND_SUBORDINATES' as const, id: h.unit('U.1.1').id }, 2 as const],
    ] as const)
      await grantManualShare(tx.kysely, {
        tenantId,
        object: 'account',
        recordId: id('acc:manual'),
        principal,
        access: level,
      });
  });

  // Sharing rules, recalculated the way the worker does it.
  const rules: Omit<SharingRuleDefinition, 'id'>[] = [
    {
      object: 'account',
      kind: 'OWNER',
      sourceType: 'ORG_UNIT_AND_SUBORDINATES',
      sourceId: h.unit('U.0.0').id,
      criteria: null,
      targetType: 'GROUP',
      targetId: id('group:outer'),
      access: 1,
      active: true,
    },
    {
      object: 'account',
      kind: 'CRITERIA',
      sourceType: null,
      sourceId: null,
      criteria: { field: 'industry', op: 'eq', value: 'Energy' },
      targetType: 'ORG_UNIT',
      targetId: h.unit('U.0.1').id,
      access: 2,
      active: true,
    },
  ];
  for (const [n, rule] of rules.entries()) {
    const stored = await inTenant((tx) =>
      tx.prisma.sharingRule.create({
        data: {
          tenantId: h.tenantId,
          name: `rule ${String(n)}`,
          object: rule.object,
          kind: rule.kind,
          sourceType: rule.sourceType,
          sourceId: rule.sourceId,
          ...(rule.criteria ? { criteria: rule.criteria } : {}),
          targetType: rule.targetType,
          targetId: rule.targetId,
          access: rule.access,
        },
      }),
    );
    await recalculateRule((fn) => inTenant((tx) => fn(tx.kysely)), {
      tenantId: h.tenantId,
      rule: { ...rule, id: stored.id },
      recordTable: 'fx_account',
      batchSize: 2,
    });
  }
  await withTenant(prisma, { tenantId: other.tenantId }, async (tx) => {
    const profiles = await provisionDefaultProfiles(tx, other.tenantId, 'en');
    await tx.prisma.user.updateMany({ data: { profileId: profiles.system_administrator } });
  });
  ids.set('stranger', other.user('U#0').id);
}, 180_000);

afterAll(async () => {
  await api.dispose();
});

// ── 1. The hierarchy matrix: every user × every user's opportunity (PRIVATE) ──────────────
/** Independent oracle (§6.3/6.4): own, anything owned below your unit, and your direct reports'. */
function hierarchySees(viewer: string, owner: string): boolean {
  const v = h.user(viewer);
  const o = h.user(owner);
  const vUnit = viewer.split('#')[0] ?? '';
  const oUnit = owner.split('#')[0] ?? '';
  return viewer === owner || oUnit.startsWith(`${vUnit}.`) || o.managerId === v.id;
}

const TREE_USERS = ['U', 'U.0', 'U.0.0', 'U.0.1', 'U.1', 'U.1.0', 'U.1.1'].flatMap((u) => [
  `${u}#0`,
  `${u}#1`,
]);
const PAIRS = TREE_USERS.flatMap((viewer) => TREE_USERS.map((owner) => [viewer, owner] as const));

describe('hierarchy matrix: opportunity (PRIVATE), every viewer × every owner', () => {
  it.each(PAIRS)('%s reading %s’s opportunity', async (viewer, owner) => {
    const decision = await inTenant((tx) =>
      access.check(tx, id(viewer), {
        object: 'opportunity',
        action: 'read',
        recordId: id(`opp:${owner}`),
      }),
    );
    expect(decision.allowed).toBe(hierarchySees(viewer, owner));
    if (!decision.allowed) expect(decision.deniedBy).toBe('record');
  });

  it.each(TREE_USERS)('the predicate returns exactly the rows %s may read', async (viewer) => {
    const rows = await visibleRows(viewer, 'opportunity', 'read');
    const expected = TREE_USERS.filter((owner) => hierarchySees(viewer, owner)).map(
      (owner) => `opp:${owner}`,
    );
    expect(rows).toEqual(expected.sort());
  });
});

// ── 2. Scenario table: one row per rule of §6.2–6.4 ───────────────────────────────────────
type Expect = true | DeniedLayer;
interface Case {
  why: string;
  user: string;
  object: FixtureObject;
  action: RecordAction;
  record?: string;
  fields?: string[];
  expect: Expect;
}

const CASES: Case[] = [
  // Owner and hierarchy on a PRIVATE object.
  {
    why: 'owner reads',
    user: 'U.1.1#1',
    object: 'account',
    action: 'read',
    record: 'acc:energy',
    expect: true,
  },
  {
    why: 'owner deletes',
    user: 'U.1.1#1',
    object: 'account',
    action: 'delete',
    record: 'acc:energy',
    expect: true,
  },
  {
    why: 'owner transfers',
    user: 'U.1.1#1',
    object: 'account',
    action: 'transfer',
    record: 'acc:energy',
    expect: true,
  },
  {
    why: 'owner shares',
    user: 'U.1.1#1',
    object: 'account',
    action: 'share',
    record: 'acc:energy',
    expect: true,
  },
  {
    why: 'unit head edits a report’s record',
    user: 'U.1.1#0',
    object: 'account',
    action: 'edit',
    record: 'acc:energy',
    expect: true,
  },
  {
    why: 'the top of the tree deletes',
    user: 'U#0',
    object: 'account',
    action: 'delete',
    record: 'acc:energy',
    expect: true,
  },
  {
    why: 'a peer in the unit above edits',
    user: 'U.1#1',
    object: 'account',
    action: 'edit',
    record: 'acc:energy',
    expect: true,
  },
  {
    why: 'a sibling unit sees nothing',
    user: 'U.1.0#0',
    object: 'account',
    action: 'read',
    record: 'acc:energy',
    expect: 'record',
  },
  {
    why: 'a member never sees their head’s records',
    user: 'U.1.1#1',
    object: 'opportunity',
    action: 'read',
    record: 'opp:U.1.1#0',
    expect: 'record',
  },
  // Criteria rule: industry = Energy → exactly org unit U.0.1, Read-Write.
  {
    why: 'criteria rule grants edit',
    user: 'U.0.1#1',
    object: 'account',
    action: 'edit',
    record: 'acc:energy',
    expect: true,
  },
  {
    why: 'criteria rule grants read',
    user: 'U.0.1#0',
    object: 'account',
    action: 'read',
    record: 'acc:energy',
    expect: true,
  },
  {
    why: 'criteria rule never grants delete',
    user: 'U.0.1#1',
    object: 'account',
    action: 'delete',
    record: 'acc:energy',
    expect: 'record',
  },
  {
    why: 'criteria rule never grants share',
    user: 'U.0.1#1',
    object: 'account',
    action: 'share',
    record: 'acc:energy',
    expect: 'record',
  },
  {
    why: 'an exact-unit rule skips other units',
    user: 'U.0.0#0',
    object: 'account',
    action: 'read',
    record: 'acc:energy',
    expect: 'record',
  },
  {
    why: 'an unmatched record is not shared',
    user: 'U.0.1#1',
    object: 'account',
    action: 'read',
    record: 'acc:u000',
    expect: 'record',
  },
  // Owner rule: records owned in U.0.0 and below → group "outer" (contains "inner" ∋ U.1.0#1), Read.
  {
    why: 'owner rule reaches a nested group member',
    user: 'U.1.0#1',
    object: 'account',
    action: 'read',
    record: 'acc:u000',
    expect: true,
  },
  {
    why: 'owner rule grants read only',
    user: 'U.1.0#1',
    object: 'account',
    action: 'edit',
    record: 'acc:u000',
    expect: 'record',
  },
  {
    why: 'owner rule skips non-members',
    user: 'U.1.0#0',
    object: 'account',
    action: 'read',
    record: 'acc:u000',
    expect: 'record',
  },
  {
    why: 'owner rule skips records owned elsewhere',
    user: 'U.1.0#1',
    object: 'account',
    action: 'read',
    record: 'acc:manual',
    expect: 'record',
  },
  {
    why: 'hierarchy still applies beside a rule',
    user: 'U.0.0#0',
    object: 'account',
    action: 'edit',
    record: 'acc:u000',
    expect: true,
  },
  {
    why: 'a sibling of the source unit sees nothing',
    user: 'U.0.1#0',
    object: 'account',
    action: 'read',
    record: 'acc:u000',
    expect: 'record',
  },
  // Manual shares on acc:manual: U.1.0#0 Read; U.1.1 and subordinates Read-Write.
  {
    why: 'manual read share',
    user: 'U.1.0#0',
    object: 'account',
    action: 'read',
    record: 'acc:manual',
    expect: true,
  },
  {
    why: 'manual read share is read only',
    user: 'U.1.0#0',
    object: 'account',
    action: 'edit',
    record: 'acc:manual',
    expect: 'record',
  },
  {
    why: 'role-and-subordinates share reaches the unit',
    user: 'U.1.1#0',
    object: 'account',
    action: 'edit',
    record: 'acc:manual',
    expect: true,
  },
  {
    why: 'role-and-subordinates share reaches its members',
    user: 'U.1.1#1',
    object: 'account',
    action: 'edit',
    record: 'acc:manual',
    expect: true,
  },
  {
    why: 'a Read-Write share never grants delete',
    user: 'U.1.1#1',
    object: 'account',
    action: 'delete',
    record: 'acc:manual',
    expect: 'record',
  },
  {
    why: 'a share to one user is not their teammate’s',
    user: 'U.1.0#1',
    object: 'account',
    action: 'read',
    record: 'acc:manual',
    expect: 'record',
  },
  {
    why: 'the manual owner keeps full access',
    user: 'U.0.1#1',
    object: 'account',
    action: 'share',
    record: 'acc:manual',
    expect: true,
  },
  // Controlled by parent: contacts follow their account.
  {
    why: 'child follows the parent’s rule access (read)',
    user: 'U.0.1#1',
    object: 'contact',
    action: 'read',
    record: 'con:energy',
    expect: true,
  },
  {
    why: 'child follows the parent’s rule access (edit)',
    user: 'U.0.1#1',
    object: 'contact',
    action: 'edit',
    record: 'con:energy',
    expect: true,
  },
  {
    why: 'child never exceeds the parent’s level',
    user: 'U.0.1#1',
    object: 'contact',
    action: 'delete',
    record: 'con:energy',
    expect: 'record',
  },
  {
    why: 'child invisible when the parent is',
    user: 'U.1.0#1',
    object: 'contact',
    action: 'read',
    record: 'con:energy',
    expect: 'record',
  },
  {
    why: 'child owner through the parent',
    user: 'U.1.1#1',
    object: 'contact',
    action: 'delete',
    record: 'con:energy',
    expect: true,
  },
  {
    why: 'hierarchy through the parent',
    user: 'U#0',
    object: 'contact',
    action: 'edit',
    record: 'con:energy',
    expect: true,
  },
  {
    why: 'orphan child: owner',
    user: 'U.0#1',
    object: 'contact',
    action: 'edit',
    record: 'con:orphan',
    expect: true,
  },
  {
    why: 'orphan child: owner’s manager',
    user: 'U.0#0',
    object: 'contact',
    action: 'read',
    record: 'con:orphan',
    expect: true,
  },
  {
    why: 'orphan child: nobody else',
    user: 'U.1#0',
    object: 'contact',
    action: 'read',
    record: 'con:orphan',
    expect: 'record',
  },
  // Public Read (lead) and queues.
  {
    why: 'public read lets anyone read',
    user: 'U.1.1#1',
    object: 'lead',
    action: 'read',
    record: 'lead:u00',
    expect: true,
  },
  {
    why: 'public read does not let others edit',
    user: 'U.1.1#1',
    object: 'lead',
    action: 'edit',
    record: 'lead:u00',
    expect: 'record',
  },
  {
    why: 'public read: owner edits',
    user: 'U.0.0#0',
    object: 'lead',
    action: 'edit',
    record: 'lead:u00',
    expect: true,
  },
  {
    why: 'public read: manager above edits',
    user: 'U.0#0',
    object: 'lead',
    action: 'edit',
    record: 'lead:u00',
    expect: true,
  },
  {
    why: 'creating needs only the object permission',
    user: 'U.1.1#1',
    object: 'lead',
    action: 'create',
    expect: true,
  },
  {
    why: 'queue member has full access',
    user: 'U.1#1',
    object: 'lead',
    action: 'delete',
    record: 'lead:queue',
    expect: true,
  },
  {
    why: 'queue member may transfer (accept) the record',
    user: 'U.1#1',
    object: 'lead',
    action: 'transfer',
    record: 'lead:queue',
    expect: true,
  },
  {
    why: 'queue records do not flow up the hierarchy',
    user: 'U.1#0',
    object: 'lead',
    action: 'edit',
    record: 'lead:queue',
    expect: 'record',
  },
  {
    why: 'non-members read queue leads under public read',
    user: 'U.1#0',
    object: 'lead',
    action: 'read',
    record: 'lead:queue',
    expect: true,
  },
  // Public Read/Write (campaign) against the object layer.
  {
    why: 'public read/write: anyone reads',
    user: 'U.1.0#1',
    object: 'campaign',
    action: 'read',
    record: 'camp:1',
    expect: true,
  },
  {
    why: 'public read/write needs the object edit permission',
    user: 'U#0',
    object: 'campaign',
    action: 'edit',
    record: 'camp:1',
    expect: 'object',
  },
  {
    why: 'public read/write: administrator edits',
    user: 'admin',
    object: 'campaign',
    action: 'edit',
    record: 'camp:1',
    expect: true,
  },
  {
    why: 'public read/write never grants delete to non-owners',
    user: 'U.1#1',
    object: 'campaign',
    action: 'delete',
    record: 'camp:1',
    expect: 'object',
  },
  // View All / Modify All.
  {
    why: 'View All reads every account',
    user: 'auditor',
    object: 'account',
    action: 'read',
    record: 'acc:energy',
    expect: true,
  },
  {
    why: 'View All reads another owner’s account',
    user: 'auditor',
    object: 'account',
    action: 'read',
    record: 'acc:minimal',
    expect: true,
  },
  {
    why: 'View All does not edit',
    user: 'auditor',
    object: 'account',
    action: 'edit',
    record: 'acc:energy',
    expect: 'record',
  },
  {
    why: 'View All is per object',
    user: 'auditor',
    object: 'opportunity',
    action: 'read',
    record: 'opp:U#0',
    expect: 'record',
  },
  {
    why: 'Modify All deletes any account',
    user: 'admin',
    object: 'account',
    action: 'delete',
    record: 'acc:manual',
    expect: true,
  },
  {
    why: 'Modify All deletes any opportunity',
    user: 'admin',
    object: 'opportunity',
    action: 'delete',
    record: 'opp:U.1.1#1',
    expect: true,
  },
  {
    why: 'Modify All shares any lead',
    user: 'admin',
    object: 'lead',
    action: 'share',
    record: 'lead:queue',
    expect: true,
  },
  // Object layer.
  {
    why: 'read-only profile reads public leads',
    user: 'ro',
    object: 'lead',
    action: 'read',
    record: 'lead:u00',
    expect: true,
  },
  {
    why: 'read-only profile never edits',
    user: 'ro',
    object: 'lead',
    action: 'edit',
    record: 'lead:u00',
    expect: 'object',
  },
  {
    why: 'read-only profile never creates',
    user: 'ro',
    object: 'account',
    action: 'create',
    expect: 'object',
  },
  {
    why: 'read-only profile: private records stay private',
    user: 'ro',
    object: 'account',
    action: 'read',
    record: 'acc:energy',
    expect: 'record',
  },
  {
    why: 'no object permission, no access',
    user: 'minimal',
    object: 'lead',
    action: 'read',
    record: 'lead:u00',
    expect: 'object',
  },
  {
    why: 'no create permission',
    user: 'minimal',
    object: 'account',
    action: 'create',
    expect: 'object',
  },
  {
    why: 'no delete permission, even as owner',
    user: 'minimal',
    object: 'account',
    action: 'delete',
    record: 'acc:minimal',
    expect: 'object',
  },
  {
    why: 'a deactivated user holds nothing',
    user: 'gone',
    object: 'lead',
    action: 'read',
    record: 'lead:u00',
    expect: 'object',
  },
  {
    why: 'a deactivated user cannot create',
    user: 'gone',
    object: 'opportunity',
    action: 'create',
    expect: 'object',
  },
  // Muting.
  {
    why: 'muted group still grants edit',
    user: 'muted',
    object: 'account',
    action: 'edit',
    record: 'acc:muted',
    expect: true,
  },
  {
    why: 'muted group still grants create',
    user: 'muted',
    object: 'account',
    action: 'create',
    expect: true,
  },
  {
    why: 'muting removes delete from the group',
    user: 'muted',
    object: 'account',
    action: 'delete',
    record: 'acc:muted',
    expect: 'object',
  },
  // Field-level security.
  {
    why: 'FLS: readable fields',
    user: 'minimal',
    object: 'account',
    action: 'read',
    record: 'acc:minimal',
    fields: ['industry', 'website'],
    expect: true,
  },
  {
    why: 'FLS: hidden field',
    user: 'minimal',
    object: 'account',
    action: 'read',
    record: 'acc:minimal',
    fields: ['website', 'annual_revenue'],
    expect: 'field',
  },
  {
    why: 'FLS: read-only field cannot be edited',
    user: 'minimal',
    object: 'account',
    action: 'edit',
    record: 'acc:minimal',
    fields: ['website'],
    expect: 'field',
  },
  {
    why: 'FLS: editable field',
    user: 'minimal',
    object: 'account',
    action: 'edit',
    record: 'acc:minimal',
    fields: ['industry'],
    expect: true,
  },
  {
    why: 'FLS: standard users edit every FLS field',
    user: 'U#0',
    object: 'account',
    action: 'edit',
    record: 'acc:energy',
    fields: ['annual_revenue', 'website'],
    expect: true,
  },
  {
    why: 'FLS: read-only profile reads fields',
    user: 'ro',
    object: 'lead',
    action: 'read',
    record: 'lead:u00',
    fields: ['phone'],
    expect: true,
  },
  {
    why: 'FLS applies after record access',
    user: 'minimal',
    object: 'account',
    action: 'read',
    record: 'acc:energy',
    fields: ['annual_revenue'],
    expect: 'record',
  },
  {
    why: 'FLS on create',
    user: 'muted',
    object: 'account',
    action: 'create',
    fields: ['annual_revenue'],
    expect: 'field',
  },
];

describe('scenario table (§6.2–6.4)', () => {
  it.each(CASES.map((c) => [c.why, c] as const))('%s', async (_, c) => {
    const decision = await inTenant((tx) =>
      access.check(tx, id(c.user), {
        object: c.object,
        action: c.action,
        ...(c.record ? { recordId: id(c.record) } : {}),
        ...(c.fields ? { fields: c.fields } : {}),
      }),
    );
    if (c.expect === true) expect(decision).toEqual({ allowed: true });
    else expect(decision).toMatchObject({ allowed: false, deniedBy: c.expect });
  });

  it('muting removes a system permission the group grants', async () => {
    const p = await inTenant((tx) => access.permissionsOf(tx, id('muted')));
    expect(hasSystemPermission(p, 'export_reports')).toBe(false);
  });

  it('a record of another workspace does not exist for its administrators', async () => {
    const decision = await withTenant(prisma, { tenantId: other.tenantId }, (tx) =>
      access.check(tx, id('stranger'), {
        object: 'account',
        action: 'read',
        recordId: id('acc:energy'),
      }),
    );
    expect(decision).toMatchObject({ allowed: false, deniedBy: 'record' });
  });
});

// ── 3. Row sets: what the predicate returns per user and level ────────────────────────────
async function visibleRows(user: string, object: string, level: AccessLevel): Promise<string[]> {
  return inTenant(async (tx) => {
    const eff = await access.permissionsOf(tx, id(user));
    const ctx = await access.sharingContext(tx, id(user), eff, object);
    const rows = await tx.kysely
      .selectFrom(`fx_${object} as r`)
      .select(sql<string>`r.id`.as('id'))
      .where(sharingPredicate(ctx, object, 'r', level))
      .execute();
    const byId = new Map([...ids].map(([k, v]) => [v, k]));
    return rows.map((r) => byId.get(r.id) ?? r.id).sort();
  });
}

const ALL_ACCOUNTS = ['acc:energy', 'acc:manual', 'acc:minimal', 'acc:muted', 'acc:u000'];
const ROWS: [string, string, AccessLevel, string[]][] = [
  ['U.1.0#1', 'account', 'read', ['acc:u000']],
  ['U.1.0#1', 'account', 'edit', []],
  ['U.1.0#0', 'account', 'read', ['acc:manual']],
  ['U.0.1#1', 'account', 'read', ['acc:energy', 'acc:manual']],
  ['U.0.1#1', 'account', 'edit', ['acc:energy', 'acc:manual']],
  ['U.0.1#1', 'account', 'full', ['acc:manual']],
  ['U.1.1#0', 'account', 'edit', ['acc:energy', 'acc:manual']],
  ['U.1.1#0', 'account', 'full', ['acc:energy']],
  ['U#0', 'account', 'full', ['acc:energy', 'acc:manual', 'acc:u000']],
  ['auditor', 'account', 'read', ALL_ACCOUNTS],
  ['auditor', 'account', 'edit', []],
  ['admin', 'account', 'full', ALL_ACCOUNTS],
  ['U.0.1#1', 'contact', 'edit', ['con:energy']],
  ['U.0#0', 'contact', 'read', ['con:orphan']],
  ['U#0', 'contact', 'full', ['con:energy', 'con:orphan']],
  ['ro', 'lead', 'read', ['lead:queue', 'lead:u00']],
  ['U.1#1', 'lead', 'edit', ['lead:queue']],
  ['U.0#0', 'lead', 'edit', ['lead:u00']],
  ['U.1.0#1', 'campaign', 'edit', ['camp:1']],
  ['U.1.0#1', 'campaign', 'full', []],
];

describe('predicate row sets', () => {
  it.each(ROWS)('%s → %s at %s', async (user, object, level, expected) => {
    expect(await visibleRows(user, object, level)).toEqual([...expected].sort());
  });

  it('agrees with AccessService on every account for every user', async () => {
    for (const user of [...TREE_USERS, ...EXTRA_USERS]) {
      const readable = await visibleRows(user, 'account', 'read');
      for (const account of ALL_ACCOUNTS) {
        const level = await inTenant((tx) =>
          access.recordAccess(tx, id(user), 'account', id(account)),
        );
        expect(level !== 'none', `${user} ${account}`).toBe(readable.includes(account));
      }
    }
  });
});
