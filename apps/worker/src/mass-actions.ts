import { withTenant } from '@sm/db';
import { MASS_ACTION_TOPIC, runMassAction } from '@sm/records';

import type { JobHandler } from './jobs.js';

/**
 * The `import` queue: mass actions over "select all matching" (§7.5, up to 10k records), run as
 * the user who started them, one transaction per batch of 200. The bulk API joins it in P12.
 */
export const importHandler: JobHandler = async (envelope, { prisma }) => {
  if (envelope.topic !== MASS_ACTION_TOPIC) throw new Error(`unknown import job ${envelope.topic}`);
  const { tenantId } = envelope;
  if (!tenantId) throw new Error(`${envelope.topic} needs a tenant`);
  await runMassAction(
    (fn) =>
      withTenant(prisma, { tenantId }, fn, { timeoutMs: 120_000, statementTimeoutMs: 60_000 }),
    envelope.payload,
  );
};
