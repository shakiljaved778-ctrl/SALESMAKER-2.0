import { withTenant, type TenantTransaction } from '@sm/db';
import {
  dryRunImport,
  IMPORT_DRY_RUN_TOPIC,
  IMPORT_RUN_TOPIC,
  IMPORT_UNDO_TOPIC,
  runImport,
  undoImport,
} from '@sm/imports';
import type { StorageProvider } from '@sm/integrations';
import { MASS_ACTION_TOPIC, runMassAction } from '@sm/records';

import type { JobHandler } from './jobs.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `import` queue: data imports (§7.1: dry run, run, undo) and mass actions over "select all
 * matching" (§7.5, up to 10k records), each run as the user who started it, a transaction per
 * batch. The bulk API joins it in P12.
 */
export function createImportHandler(deps: { storage?: StorageProvider } = {}): JobHandler {
  return async (envelope, { prisma }) => {
    const { tenantId } = envelope;
    if (!tenantId) throw new Error(`${envelope.topic} needs a tenant`);
    const inTenant = <T>(fn: (tx: TenantTransaction) => Promise<T>) =>
      withTenant(prisma, { tenantId }, fn, { timeoutMs: 120_000, statementTimeoutMs: 60_000 });
    if (envelope.topic === MASS_ACTION_TOPIC) {
      await runMassAction(inTenant, envelope.payload);
      return;
    }
    const imports = [IMPORT_RUN_TOPIC, IMPORT_DRY_RUN_TOPIC, IMPORT_UNDO_TOPIC];
    if (!imports.includes(envelope.topic)) throw new Error(`unknown import job ${envelope.topic}`);
    if (!deps.storage) throw new Error('object storage is not configured (S3_*)');
    const { jobId } = envelope.payload as { jobId?: unknown };
    if (typeof jobId !== 'string' || !UUID.test(jobId))
      throw new Error(`${envelope.topic} needs a jobId`);
    const importDeps = { inTenant, storage: deps.storage };
    if (envelope.topic === IMPORT_RUN_TOPIC) await runImport(importDeps, jobId);
    else if (envelope.topic === IMPORT_DRY_RUN_TOPIC) await dryRunImport(importDeps, jobId);
    else await undoImport(importDeps, jobId);
  };
}

/** Without object storage (tests): mass actions only. */
export const importHandler: JobHandler = createImportHandler();
