import {
  membership,
  visibility,
  withTenant,
  type CellPrisma,
  type TenantTransaction,
} from '@sm/db';
import { hasSystemPermission } from '@sm/permissions';
import argon2 from 'argon2';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ARGON2_OPTIONS } from '../src/auth/password.service.js';
import { PermissionService } from '../src/permissions/permission.service.js';
import { DEFAULT_SEED_PASSWORD, parseSeedArgs } from '../src/seed/main.js';
import { BANK_SHAPE, seedPlan, type SeedPlan } from '../src/seed/scenarios.js';
import { applySeedPlan } from '../src/seed/seed.js';
import { PRISMA } from '../src/tokens.js';
import { startTestApi, type TestApi } from './support.js';

let api: TestApi;
let prisma: CellPrisma;
let passwordHash = '';
const tenants: Record<string, string> = { agency: uuidv7(), bank: uuidv7() };

const inTenant = <T>(tenant: string, fn: (tx: TenantTransaction) => Promise<T>) =>
  withTenant(prisma, { tenantId: tenants[tenant] ?? '' }, fn);
const userId = (tenant: string, email: string) =>
  inTenant(tenant, async (tx) => (await tx.prisma.user.findFirstOrThrow({ where: { email } })).id);
const emailOf = (plan: SeedPlan, key: string) => {
  const user = plan.users.find((u) => u.key === key);
  if (!user) throw new Error(`no ${key}`);
  return user.email;
};

beforeAll(async () => {
  api = await startTestApi();
  prisma = api.app.get<symbol, CellPrisma>(PRISMA);
  passwordHash = await argon2.hash(DEFAULT_SEED_PASSWORD, ARGON2_OPTIONS);
});

afterAll(async () => {
  await api.dispose();
});

describe('seed plans (§15)', () => {
  it('are deterministic', () => {
    expect(seedPlan('bank')).toEqual(seedPlan('bank'));
    expect(seedPlan('agency')).toEqual(seedPlan('agency'));
  });

  it('shape the bank as Company → 4 regions → 20 branches → 80 teams of 10, plus a hub', () => {
    const plan = seedPlan('bank');
    const reps = plan.users.filter((u) => /-team-[a-d]-rep-/.test(u.key));
    const { regions, branchesPerRegion, teamsPerBranch, repsPerTeam } = BANK_SHAPE;
    expect(reps).toHaveLength(regions * branchesPerRegion * teamsPerBranch * repsPerTeam);
    expect(plan.units.filter((u) => u.key.includes('-team-'))).toHaveLength(80);
    expect(plan.units.filter((u) => /-branch-\d+$/.test(u.key))).toHaveLength(20);
    expect(plan.units.find((u) => u.key === 'hub')?.parent).toBe('company');
    expect(new Set(plan.users.map((u) => u.email)).size).toBe(plan.users.length);
    expect(new Set(plan.users.map((u) => u.title))).toEqual(
      new Set([
        'Head of Sales Operations',
        'Compliance Officer',
        ...['North', 'South', 'East', 'West'].map((r) => `Regional Director, ${r}`),
        'Branch Manager',
        'Team Leader',
        'Telesales Agent',
        'Relationship Officer',
        'Telesales Hub Manager',
      ]),
    );
    expect(plan.profiles.map((p) => p.name ?? p.builtIn)).toEqual([
      'system_administrator',
      'standard_user',
      'read_only',
      'Director',
      'Branch Manager',
      'Team Leader',
      'Telesales Agent',
      'Relationship Officer',
      'Compliance Viewer',
    ]);
  });

  it('list parents before children and managers before their reports', () => {
    for (const plan of [seedPlan('agency'), seedPlan('bank')]) {
      const units = new Set<string>();
      for (const u of plan.units) {
        if (u.parent) expect(units.has(u.parent), u.key).toBe(true);
        units.add(u.key);
      }
      const users = new Set<string>();
      for (const u of plan.users) {
        if (u.manager) expect(users.has(u.manager), u.key).toBe(true);
        expect(units.has(u.unit), u.key).toBe(true);
        users.add(u.key);
      }
      expect(plan.users[0]?.key).toBe(plan.owner);
    }
  });

  it('parses the command line', () => {
    expect(parseSeedArgs(['--scenario=bank'])).toEqual({ scenarios: ['bank'], scale: 'demo' });
    expect(parseSeedArgs(['--scale=load'])).toEqual({
      scenarios: ['agency', 'bank'],
      scale: 'load',
    });
    expect(() => parseSeedArgs(['--scenario=zoo'])).toThrow(/scenario/);
    expect(() => parseSeedArgs(['--scale=huge'])).toThrow(/scale/);
  });
});

describe('applying the agency', () => {
  const plan = seedPlan('agency');

  it('creates the workspace, its people and their access, and is idempotent', async () => {
    const first = await applySeedPlan(prisma, plan, {
      tenantId: tenants['agency'] ?? '',
      region: 'eu-central-1',
      passwordHash,
    });
    expect(first).toMatchObject({ created: true, users: 6, units: 2 });
    const again = await applySeedPlan(prisma, plan, {
      tenantId: tenants['agency'] ?? '',
      region: 'eu-central-1',
      passwordHash,
    });
    expect(again).toMatchObject({ created: false, users: 6, units: 2 });
    const settings = await inTenant('agency', (tx) =>
      tx.prisma.tenantSettings.findUniqueOrThrow({
        where: { tenantId: tenants['agency'] ?? '' },
      }),
    );
    expect(settings).toMatchObject({ slug: 'pixelcraft-demo', corporateCurrency: 'USD' });
    expect(settings.ownerUserId).toBe(await userId('agency', emailOf(plan, 'owner')));
  });

  it('lets every seeded user sign in with the demo password', async () => {
    const res = await api.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'x-sm-tenant-id': tenants['agency'] ?? '' },
      payload: { email: emailOf(plan, 'priya'), password: DEFAULT_SEED_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
  });

  it('gives the dual-role rep the account-management set and the manager sight of the team', async () => {
    const priya = await userId('agency', emailOf(plan, 'priya'));
    const permissions = await inTenant('agency', (tx) =>
      api.app.get(PermissionService).forUser(tx, priya),
    );
    expect(hasSystemPermission(permissions, 'transfer_records')).toBe(true);
    expect(permissions.objects['account']?.viewAll).toBe(true);
    const manager = await userId('agency', emailOf(plan, 'manager'));
    const sees = await inTenant('agency', (tx) => visibility.ownersVisibleTo(tx, manager));
    expect(sees).toContain(priya);
  });
});

describe('applying the bank', () => {
  const plan = seedPlan('bank');

  it('seeds 900+ users with the hierarchy, visibility, groups and queues', async () => {
    const result = await applySeedPlan(prisma, plan, {
      tenantId: tenants['bank'] ?? '',
      region: 'eu-central-1',
      passwordHash,
    });
    expect(result).toMatchObject({ created: true, users: plan.users.length });
    const director = await userId('bank', emailOf(plan, 'region-1-director'));
    const regionSize = 1 + 5 + 5 * 4 + 5 * 4 * 10;
    await inTenant('bank', async (tx) => {
      const inbound = await tx.prisma.queue.findFirstOrThrow({
        where: { name: 'North Region inbound' },
      });
      expect(await membership.queueUsers(tx, inbound.id)).toHaveLength(regionSize);
      // The director sees the region's people and, as a member, the region's inbound queue.
      const sees = await visibility.ownersVisibleTo(tx, director);
      expect(sees).toHaveLength(regionSize + 1);
      expect(sees).toContain(inbound.id);
      const leadership = await tx.prisma.publicGroup.findFirstOrThrow({
        where: { name: 'Leadership' },
      });
      expect(await membership.groupUsers(tx, leadership.id)).toHaveLength(6);
      expect(await tx.prisma.user.count({ where: { timezone: 'Asia/Dubai' } })).toBeGreaterThan(
        200,
      );
    });
  });

  it('applies the bank profiles: agents cannot delete, compliance reads everything', async () => {
    const perms = (email: string) =>
      userId('bank', email).then((id) =>
        inTenant('bank', (tx) => api.app.get(PermissionService).forUser(tx, id)),
      );
    const agent = await perms(emailOf(plan, 'region-1-branch-1-team-a-rep-1'));
    expect(agent.objects['lead']).toMatchObject({ edit: true, delete: false });
    const officer = await perms(emailOf(plan, 'region-1-branch-1-team-c-rep-1'));
    expect(officer.objects['lead']).toMatchObject({ delete: true });
    const compliance = await perms(emailOf(plan, 'compliance-1'));
    expect(hasSystemPermission(compliance, 'view_all_data')).toBe(true);
    expect(compliance.objects['lead']).toMatchObject({ read: true, edit: false });
    const director = await perms(emailOf(plan, 'region-1-director'));
    // The operations group grants automations; its muting set removes only its own export.
    expect(hasSystemPermission(director, 'manage_automations')).toBe(true);
    expect(hasSystemPermission(director, 'export_reports')).toBe(true);
    const hub = await perms(emailOf(plan, 'hub-manager'));
    expect(hasSystemPermission(hub, 'bypass_calling_window')).toBe(true);
  });
});
