import { visibility, withTenant, type CellPrisma } from '@sm/db';
import { uuidv7 } from 'uuidv7';

export interface HierarchyOptions {
  /** Levels of org units below the root (0 = the root alone). */
  depth: number;
  usersPerUnit: number;
  /** Child units per unit (default 2). */
  branching?: number;
  tenantId?: string;
  slug?: string;
}

export interface HierarchyUnit {
  id: string;
  /** `U`, `U.0`, `U.0.1`, …: the path of child indexes from the root. */
  name: string;
  parentId: string | null;
  depth: number;
}

export interface HierarchyUser {
  id: string;
  /** `<unit>#<n>`, e.g. `U.0#1`. User #0 heads the unit. */
  name: string;
  email: string;
  unitId: string;
  /** Members report to their unit's head; a head reports to the parent unit's head. */
  managerId: string | null;
}

export interface TenantHierarchy {
  tenantId: string;
  units: HierarchyUnit[];
  users: HierarchyUser[];
  unit(name: string): HierarchyUnit;
  user(name: string): HierarchyUser;
}

/**
 * A workspace with a full org-unit tree (`branching` children per unit, `depth` levels) and
 * `usersPerUnit` active, verified users in every unit, managers set, and owner visibility built
 * (spec §13.3). Profiles and permissions are left to the caller.
 */
export async function makeTenantWithHierarchy(
  prisma: CellPrisma,
  options: HierarchyOptions,
): Promise<TenantHierarchy> {
  const tenantId = options.tenantId ?? uuidv7();
  const slug = options.slug ?? `hier-${tenantId.slice(-12)}`;
  const branching = options.branching ?? 2;
  const units: HierarchyUnit[] = [];
  const users: HierarchyUser[] = [];
  await withTenant(
    prisma,
    { tenantId },
    async (tx) => {
      await tx.prisma.tenantSettings.create({
        data: {
          tenantId,
          name: slug,
          slug,
          region: 'eu-central-1',
          corporateCurrency: 'USD',
          defaultTimezone: 'UTC',
        },
      });
      const heads = new Map<string, string>();
      const build = async (name: string, parent: HierarchyUnit | null, depth: number) => {
        const row = await tx.prisma.orgUnit.create({
          data: { tenantId, name, parentId: parent?.id ?? null },
        });
        const unit = { id: row.id, name, parentId: parent?.id ?? null, depth };
        units.push(unit);
        for (let n = 0; n < options.usersPerUnit; n += 1) {
          const head = heads.get(unit.id);
          const managerId =
            n === 0 ? (parent ? (heads.get(parent.id) ?? null) : null) : (head ?? null);
          const userName = `${name}#${String(n)}`;
          const email = `${userName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}@${slug}.test`;
          const user = await tx.prisma.user.create({
            data: {
              tenantId,
              email,
              name: userName,
              status: 'ACTIVE',
              emailVerifiedAt: new Date(),
              orgUnitId: unit.id,
              managerId,
            },
          });
          if (n === 0) heads.set(unit.id, user.id);
          users.push({ id: user.id, name: userName, email, unitId: unit.id, managerId });
        }
        if (depth < options.depth)
          for (let c = 0; c < branching; c += 1)
            await build(`${name}.${String(c)}`, unit, depth + 1);
      };
      await build('U', null, 0);
      await visibility.rebuild(tx);
    },
    { timeoutMs: 120_000, statementTimeoutMs: 60_000 },
  );
  const find = <T extends { name: string }>(list: T[], name: string): T => {
    const found = list.find((x) => x.name === name);
    if (!found) throw new Error(`no ${name} in this hierarchy`);
    return found;
  };
  return {
    tenantId,
    units,
    users,
    unit: (name) => find(units, name),
    user: (name) => find(users, name),
  };
}
