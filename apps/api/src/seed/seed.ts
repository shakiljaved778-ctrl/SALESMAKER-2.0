import { visibility, withTenant, type CellPrisma } from '@sm/db';
import { uuidv7 } from 'uuidv7';

import { provisionDefaultProfiles, writeGrants } from '../permissions/default-profiles.js';
import { provisionOrgWideDefaults } from '../sharing/sharing.service.js';
import type { SeedMember, SeedPlan } from './scenarios.js';

export interface SeedResult {
  tenantId: string;
  created: boolean;
  users: number;
  units: number;
}

const LONG = { timeoutMs: 300_000, statementTimeoutMs: 120_000 };

/** Look up a key in a plan map, failing loudly on a typo in the scenario. */
function lookup(map: Map<string, string>, what: string, key: string): string {
  const id = map.get(key);
  if (!id) throw new Error(`seed plan refers to unknown ${what} "${key}"`);
  return id;
}

/**
 * Write a seed plan into a workspace the control plane has reserved, in one tenant transaction.
 * Idempotent: a workspace that already exists is left exactly as it is. Every user signs in with
 * the same password, hashed once by the caller.
 */
export async function applySeedPlan(
  prisma: CellPrisma,
  plan: SeedPlan,
  options: { tenantId: string; region: string; passwordHash: string },
): Promise<SeedResult> {
  const { tenantId } = options;
  return withTenant(
    prisma,
    { tenantId },
    async (tx) => {
      const { prisma: p } = tx;
      if (await p.tenantSettings.findUnique({ where: { tenantId } }))
        return {
          tenantId,
          created: false,
          users: await p.user.count(),
          units: await p.orgUnit.count(),
        };
      await p.tenantSettings.create({
        data: {
          tenantId,
          name: plan.workspace.name,
          slug: plan.workspace.slug,
          region: options.region,
          corporateCurrency: plan.workspace.currency,
          defaultTimezone: plan.workspace.timezone,
          defaultLocale: plan.workspace.locale,
        },
      });
      await provisionOrgWideDefaults(tx);

      // Profiles and permission sets.
      const builtIns = await provisionDefaultProfiles(tx, tenantId, plan.workspace.locale);
      const profiles = new Map<string, string>();
      for (const profile of plan.profiles) {
        if (profile.builtIn) {
          profiles.set(profile.key, builtIns[profile.builtIn]);
          continue;
        }
        const name = profile.name ?? profile.key;
        const set = await p.permissionSet.create({ data: { tenantId, kind: 'PROFILE', name } });
        if (profile.grants) await writeGrants(tx, tenantId, set.id, profile.grants);
        const row = await p.profile.create({
          data: {
            tenantId,
            name,
            description: profile.description ?? null,
            permissionSetId: set.id,
          },
        });
        profiles.set(profile.key, row.id);
      }
      const sets = new Map<string, string>();
      for (const s of plan.permissionSets) {
        const set = await p.permissionSet.create({
          data: { tenantId, name: s.name, description: s.description },
        });
        await writeGrants(tx, tenantId, set.id, s.grants);
        sets.set(s.key, set.id);
      }
      const setGroups = new Map<string, string>();
      for (const g of plan.permissionSetGroups) {
        const group = await p.permissionSetGroup.create({ data: { tenantId, name: g.name } });
        if (g.muting) {
          const muting = await p.permissionSet.create({
            data: { tenantId, kind: 'MUTING', name: `muting:${group.id}` },
          });
          await writeGrants(tx, tenantId, muting.id, g.muting);
          await p.permissionSetGroup.update({
            where: { tenantId_id: { tenantId, id: group.id } },
            data: { mutingSetId: muting.id },
          });
        }
        await p.permissionSetGroupMember.createMany({
          data: g.sets.map((key) => ({
            tenantId,
            groupId: group.id,
            permissionSetId: lookup(sets, 'permission set', key),
          })),
        });
        setGroups.set(g.key, group.id);
      }

      // The hierarchy, parents before children.
      const units = new Map<string, string>();
      for (const unit of plan.units) {
        const row = await p.orgUnit.create({
          data: {
            tenantId,
            name: unit.name,
            parentId: unit.parent ? lookup(units, 'unit', unit.parent) : null,
          },
        });
        units.set(unit.key, row.id);
      }

      // Users, managers before their reports (the plan lists them in that order).
      const users = new Map(plan.users.map((u) => [u.key, uuidv7()]));
      const now = new Date();
      for (let i = 0; i < plan.users.length; i += 500) {
        const batch = plan.users.slice(i, i + 500);
        await p.user.createMany({
          data: batch.map((u) => ({
            tenantId,
            id: lookup(users, 'user', u.key),
            email: u.email,
            name: u.name,
            title: u.title,
            status: 'ACTIVE' as const,
            emailVerifiedAt: now,
            timezone: u.timezone,
            profileId: lookup(profiles, 'profile', u.profile),
            orgUnitId: lookup(units, 'unit', u.unit),
            managerId: u.manager ? lookup(users, 'user', u.manager) : null,
          })),
        });
        await p.userIdentity.createMany({
          data: batch.map((u) => {
            const userId = lookup(users, 'user', u.key);
            return {
              tenantId,
              userId,
              provider: 'password',
              subject: userId,
              passwordHash: options.passwordHash,
            };
          }),
        });
      }
      await p.permissionAssignment.createMany({
        data: plan.users.flatMap((u) => [
          ...u.permissionSets.map((key) => ({
            tenantId,
            userId: lookup(users, 'user', u.key),
            permissionSetId: lookup(sets, 'permission set', key),
          })),
          ...u.permissionSetGroups.map((key) => ({
            tenantId,
            userId: lookup(users, 'user', u.key),
            permissionSetGroupId: lookup(setGroups, 'permission set group', key),
          })),
        ]),
      });

      // Groups (nested groups are listed after the groups they contain) and queues.
      const groups = new Map<string, string>();
      const member = (m: SeedMember) => ({
        memberType: m.type,
        userId: m.type === 'USER' ? lookup(users, 'user', m.key) : null,
        memberGroupId: m.type === 'GROUP' ? lookup(groups, 'group', m.key) : null,
        orgUnitId:
          m.type === 'ORG_UNIT' || m.type === 'ORG_UNIT_AND_SUBORDINATES'
            ? lookup(units, 'unit', m.key)
            : null,
      });
      for (const g of plan.groups) {
        const group = await p.publicGroup.create({ data: { tenantId, name: g.name } });
        groups.set(g.key, group.id);
        await p.groupMember.createMany({
          data: g.members.map((m) => ({ tenantId, groupId: group.id, ...member(m) })),
        });
      }
      for (const q of plan.queues) {
        const queue = await p.queue.create({ data: { tenantId, name: q.name, email: q.email } });
        await p.queueObject.createMany({
          data: q.objects.map((object) => ({ tenantId, queueId: queue.id, object })),
        });
        await p.queueMember.createMany({
          data: q.members.map((m) => ({ tenantId, queueId: queue.id, ...member(m) })),
        });
      }

      await p.tenantSettings.update({
        where: { tenantId },
        data: { ownerUserId: lookup(users, 'user', plan.owner) },
      });
      await visibility.rebuild(tx);
      return { tenantId, created: true, users: plan.users.length, units: plan.units.length };
    },
    LONG,
  );
}
