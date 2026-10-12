import { withTenant, type TenantTransaction } from '@sm/db';
import { INBOUND_EMAIL_TOPIC, processInboundEmail } from '@sm/imports';
import type { StorageProvider } from '@sm/integrations';

import type { JobHandler } from './jobs.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `email-sync` queue: email-to-lead (§7.1) now; mailbox sync joins it in P04. Each inbound
 * email is parsed and becomes a lead, or is stored on the lead or contact its sender already is.
 */
export function createEmailSyncHandler(
  deps: { storage?: StorageProvider | undefined } = {},
): JobHandler {
  return async (envelope, { prisma }) => {
    if (envelope.topic !== INBOUND_EMAIL_TOPIC)
      throw new Error(`unknown email-sync job ${envelope.topic}`);
    const { tenantId } = envelope;
    if (!tenantId) throw new Error(`${envelope.topic} needs a tenant`);
    const { emailId } = envelope.payload as { emailId?: unknown };
    if (typeof emailId !== 'string' || !UUID.test(emailId))
      throw new Error(`${envelope.topic} needs an emailId`);
    if (!deps.storage) throw new Error('object storage is not configured (S3_*)');
    await processInboundEmail(
      {
        storage: deps.storage,
        inTenant: <T>(fn: (tx: TenantTransaction) => Promise<T>) =>
          withTenant(prisma, { tenantId }, fn, { timeoutMs: 60_000, statementTimeoutMs: 30_000 }),
      },
      emailId,
    );
  };
}
