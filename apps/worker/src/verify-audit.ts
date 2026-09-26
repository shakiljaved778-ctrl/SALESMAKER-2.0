// Verify one organisation's audit chain now, instead of waiting for the daily run (runbook:
// docs/runbooks/audit-chain.md). Chains anything still waiting, verifies the whole chain, records
// the result where Setup shows it, and prints it.
//
//   node --env-file=../../.env dist/verify-audit.js <tenant-id>
import { withTenant } from '@sm/db';

import { loadConfig } from './config.js';
import { AUDIT_VERIFY_TOPIC, createMaintenanceHandler } from './maintenance.js';
import { createWorker } from './worker.js';

const tenantId = process.argv[2];
if (!tenantId) {
  process.stderr.write('usage: verify-audit <tenant-id>\n');
  process.exit(2);
}
const worker = await createWorker(loadConfig());
try {
  const handler = createMaintenanceHandler({
    auditPrisma: worker.auditPrisma,
    redis: worker.redis,
  });
  await handler(
    {
      eventId: `${AUDIT_VERIFY_TOPIC}:${tenantId}`,
      tenantId,
      topic: AUDIT_VERIFY_TOPIC,
      aggregateType: null,
      aggregateId: null,
      payload: {},
      createdAt: new Date().toISOString(),
    },
    { prisma: worker.prisma, logger: worker.logger, job: undefined as never },
  );
  const run = await withTenant(worker.prisma, { tenantId }, (tx) =>
    tx.prisma.auditVerification.findFirstOrThrow({ orderBy: { startedAt: 'desc' } }),
  );
  const summary = {
    status: run.status,
    throughSeq: run.throughSeq === null ? null : String(run.throughSeq),
    rows: String(run.rows),
    pending: String(run.pending),
    problem: run.problem,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  process.exitCode = run.status === 'OK' ? 0 : 1;
} finally {
  await worker.stop();
}
