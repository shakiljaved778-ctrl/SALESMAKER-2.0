import { visibility, withTenant } from '@sm/db';
import { z } from 'zod';

import type { JobHandler } from './jobs.js';

/** Recompute owner visibility after a hierarchy, manager or queue change (§6.4). */
export const VISIBILITY_CHANGED = 'sharing.visibility_changed';

const VisibilityPayload = z.object({
  /** Viewers to recompute; omitted means every user of the tenant. */
  viewers: z.array(z.uuid()).optional(),
});

/** Sharing recalculation jobs (§6.4). Each runs in its tenant's transaction. */
export const sharingHandler: JobHandler = async (envelope, { prisma, logger }) => {
  const { tenantId } = envelope;
  if (!tenantId) throw new Error(`${envelope.topic} needs a tenant`);
  if (envelope.topic === VISIBILITY_CHANGED) {
    const { viewers } = VisibilityPayload.parse(envelope.payload);
    const rows = await withTenant(prisma, { tenantId }, (tx) => visibility.rebuild(tx, viewers), {
      statementTimeoutMs: 60_000,
      timeoutMs: 120_000,
    });
    logger.info({ viewers: viewers?.length ?? 'all', rows }, 'owner visibility rebuilt');
    return;
  }
  throw new Error(`unknown sharing job ${envelope.topic}`);
};
