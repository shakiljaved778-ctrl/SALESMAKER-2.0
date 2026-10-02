/**
 * `pnpm db:seed --scenario=agency|bank [--scale=demo|load]` (§15): reserves the demo workspace in
 * the control plane (the control API must be running), then writes its identity data into this
 * cell. Idempotent: an existing demo workspace is left alone. Local and staging only.
 */
import { createCellPrisma, disposeCellPrisma, withTenant, type CellPrisma } from '@sm/db';
import {
  DomainError,
  emailRoutingHmac,
  HttpControlPlane,
  importEd25519PrivateKey,
} from '@sm/server-kit';
import argon2 from 'argon2';

import { ARGON2_OPTIONS } from '../auth/password.service.js';
import { loadConfig } from '../config.js';
import { seedCrm } from './crm.js';
import { seedPlan, type ScenarioName } from './scenarios.js';
import { applySeedPlan } from './seed.js';

/** The demo password every seeded user signs in with, unless SEED_PASSWORD overrides it. */
export const DEFAULT_SEED_PASSWORD = 'demo passphrase 4821';

export interface SeedArgs {
  scenarios: ScenarioName[];
  scale: 'demo' | 'load';
}

export function parseSeedArgs(argv: readonly string[]): SeedArgs {
  const value = (name: string) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const scenario = value('scenario') ?? 'all';
  const scale = value('scale') ?? 'demo';
  if (!['agency', 'bank', 'all'].includes(scenario))
    throw new Error('--scenario must be agency, bank or all');
  if (scale !== 'demo' && scale !== 'load') throw new Error('--scale must be demo or load');
  return {
    scenarios: scenario === 'all' ? ['agency', 'bank'] : [scenario as ScenarioName],
    scale,
  };
}

/** A tenant of this cell by its workspace address (each tenant's settings are read under RLS). */
async function findTenantBySlug(
  prisma: CellPrisma,
  controlPlane: HttpControlPlane,
  slug: string,
): Promise<string | null> {
  let after: string | undefined;
  do {
    const page = await controlPlane.listCellTenants(after ? { after } : {});
    for (const tenantId of page.tenantIds) {
      const settings = await withTenant(prisma, { tenantId }, (tx) =>
        tx.prisma.tenantSettings.findUnique({ where: { tenantId }, select: { slug: true } }),
      );
      if (settings?.slug.toLowerCase() === slug.toLowerCase()) return tenantId;
    }
    after = page.next ?? undefined;
  } while (after);
  return null;
}

async function main(): Promise<void> {
  const args = parseSeedArgs(process.argv.slice(2));
  const config = loadConfig();
  if (process.env['NODE_ENV'] === 'production')
    throw new Error('Demo seeds never run in production');
  const password = process.env['SEED_PASSWORD'] ?? DEFAULT_SEED_PASSWORD;
  const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);
  const controlPlane = new HttpControlPlane(
    config.CONTROL_API_BASE_URL,
    config.CELL_ID,
    await importEd25519PrivateKey(config.CELL_SERVICE_PRIVATE_KEY_PEM),
    config.CELL_SERVICE_KID,
  );
  const prisma = createCellPrisma(config.CELL_DATABASE_URL);
  try {
    for (const scenario of args.scenarios) {
      const plan = seedPlan(scenario);
      const owner = plan.users.find((u) => u.key === plan.owner);
      if (!owner) throw new Error(`the ${scenario} plan has no owner`);
      // The reservation is idempotent for a day; after that an existing demo workspace answers
      // 409 (address taken), and is found among this cell's tenants by its address instead.
      const reserved = await controlPlane
        .reserveTenant(`seed:${scenario}`, {
          slug: plan.workspace.slug,
          name: plan.workspace.name,
          ownerEmailHmac: emailRoutingHmac(owner.email, config.EMAIL_ROUTING_PEPPER).toString(
            'base64url',
          ),
        })
        .catch(async (err: unknown) => {
          if (!(err instanceof DomainError) || err.status !== 409) throw err;
          const tenantId = await findTenantBySlug(prisma, controlPlane, plan.workspace.slug);
          if (!tenantId) throw err;
          return { tenantId };
        });
      const result = await applySeedPlan(prisma, plan, {
        tenantId: reserved.tenantId,
        region: config.CELL_ID,
        passwordHash,
      });
      await controlPlane.activateTenant(reserved.tenantId).catch((err: unknown) => {
        // A workspace seeded on an earlier run is active already.
        if (result.created || !(err instanceof DomainError) || err.status !== 409) throw err;
      });
      // CRM records (P02): resumable, so a re-run fills in whatever is missing.
      const crm = await seedCrm(prisma, plan, {
        tenantId: reserved.tenantId,
        scale: args.scale,
        ...(process.env['SEED_CONCURRENCY']
          ? { concurrency: Number(process.env['SEED_CONCURRENCY']) }
          : {}),
        log: (line) => process.stdout.write(`${line}\n`),
      });
      process.stdout.write(
        `${plan.workspace.name} (${plan.workspace.slug}): ${
          result.created ? 'created' : 'already seeded'
        } — ${String(result.users)} users, ${String(result.units)} org units; CRM ${
          crm.skipped
            ? 'already seeded'
            : `+${String(crm.created.accounts)} accounts, +${String(crm.created.contacts)} contacts, +${String(crm.created.leads)} leads, +${String(crm.created.opportunities)} opportunities`
        }. ` + `Sign in as ${owner.email}.\n`,
      );
    }
    process.stdout.write(
      process.env['SEED_PASSWORD']
        ? 'Every seeded user signs in with SEED_PASSWORD.\n'
        : `Every seeded user signs in with the password "${DEFAULT_SEED_PASSWORD}".\n`,
    );
  } finally {
    await disposeCellPrisma(prisma);
  }
}

if (process.argv[1]?.endsWith('seed/main.js')) await main();
