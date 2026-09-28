import {
  audit,
  fieldHistory,
  loadTenantMetadata,
  outbox,
  withTenant,
  type CellPrisma,
  type ChainResult,
} from '@sm/db';
import { MetadataIndex } from '@sm/metadata';
import { CURRENCY_RECALC_TOPIC, purgeRecycleBin, recalculateCorporateAmounts } from '@sm/records';
import type { ControlPlane } from '@sm/server-kit';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import type { JobHandler } from './jobs.js';
import type { QueueSet } from './queues.js';

export const OUTBOX_PARTITIONS_TOPIC = 'maintenance.outbox_partitions';
/** Chain a tenant's new audit rows (emitted by every audit.record). */
export const AUDIT_CHAIN_TOPIC = 'maintenance.audit_chain';
/** Chain and verify every tenant's audit log (daily, cell-wide). */
export const AUDIT_VERIFY_TOPIC = 'maintenance.audit_verify';
/** Hard-delete recycle-bin items past their purge date (daily, cell-wide; §7.5). */
export const RECYCLE_PURGE_TOPIC = 'maintenance.recycle_purge';

export interface MaintenanceDeps {
  /** Connected as sm_audit: the only role that may set an audit row's hash. */
  auditPrisma?: CellPrisma;
  redis?: Redis;
  controlPlane?: Pick<ControlPlane, 'listCellTenants'>;
  /** How long a per-tenant chain lock lives if its holder dies. */
  lockMs?: number;
}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`maintenance job needs ${what}`);
  return value;
}

/**
 * Chain one tenant's audit rows. One chain run per tenant at a time, serialised by a Valkey lock
 * (the ADR-0008 addendum's group key; never a database lock). No request is lost: every caller
 * first marks the tenant dirty, then tries the lock. The holder clears the mark after releasing
 * the lock and runs again if it was set; a caller that marked it later finds the lock free.
 */
/**
 * `wait`: when another run holds the lock, wait for it (up to the lock's lifetime) and chain
 * afterwards, instead of leaving the work to it. Verification needs this: it must see every row
 * that was committed before it started as chained.
 */
async function chainTenant(deps: MaintenanceDeps, tenantId: string, wait = false) {
  const redis = need(deps.redis, 'Valkey');
  const auditPrisma = need(deps.auditPrisma, 'the sm_audit connection');
  const lock = `audit-chain:${tenantId}`;
  const dirty = `audit-chain-dirty:${tenantId}`;
  const token = `${String(process.pid)}:${String(Math.random())}`;
  const total: ChainResult = { rows: 0, batches: 0, gaps: [], headSeq: null };
  await redis.set(dirty, '1', 'PX', 3_600_000);
  const giveUpAt = Date.now() + (deps.lockMs ?? 60_000);
  for (;;) {
    if ((await redis.set(lock, token, 'PX', deps.lockMs ?? 60_000, 'NX')) !== 'OK') {
      if (!wait || Date.now() > giveUpAt) return total;
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    try {
      await redis.del(dirty);
      const result = await audit.chain((fn) =>
        withTenant(auditPrisma, { tenantId }, fn, { timeoutMs: 60_000 }),
      );
      total.rows += result.rows;
      total.batches += result.batches;
      total.gaps.push(...result.gaps);
      total.headSeq = result.headSeq ?? total.headSeq;
    } finally {
      // Release only our own lock.
      await redis.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
        1,
        lock,
        token,
      );
    }
    if ((await redis.getdel(dirty)) === null) return total;
  }
}

/** Chain a tenant's log, verify it end to end, and record the result (§6.7). */
async function verifyTenant(
  deps: MaintenanceDeps,
  prisma: CellPrisma,
  logger: Logger,
  tenantId: string,
): Promise<void> {
  const startedAt = new Date();
  await chainTenant(deps, tenantId, true);
  const result = await withTenant(prisma, { tenantId }, (tx) => audit.verify(tx), {
    timeoutMs: 120_000,
    statementTimeoutMs: 60_000,
  });
  await withTenant(prisma, { tenantId }, (tx) =>
    tx.prisma.auditVerification.create({
      data: {
        tenantId,
        startedAt,
        finishedAt: new Date(),
        status: result.ok ? 'OK' : 'BROKEN',
        throughSeq: result.throughSeq,
        batches: result.batches,
        rows: result.rows,
        pending: result.pending,
        problem: result.problem,
      },
    }),
  );
  if (!result.ok) logger.error({ tenantId, problem: result.problem }, 'audit chain broken');
}

const PURGE_BATCH = 500;

/** Purge one tenant's expired recycle-bin items, in batches so no transaction runs long. */
async function purgeTenant(prisma: CellPrisma, tenantId: string, now: Date): Promise<number> {
  let total = 0;
  for (;;) {
    const purged = await withTenant(
      prisma,
      { tenantId },
      async (tx) => {
        const settings = await tx.prisma.tenantSettings.findUnique({
          where: { tenantId },
          select: { metadataVersion: true },
        });
        if (!settings) return 0;
        const metadata = new MetadataIndex(await loadTenantMetadata(tx, settings.metadataVersion));
        return purgeRecycleBin(tx, metadata, { now, limit: PURGE_BATCH });
      },
      { timeoutMs: 120_000 },
    );
    total += purged;
    if (purged < PURGE_BATCH) return total;
  }
}

/** Pages through the cell's tenants. */
async function eachTenant(
  deps: MaintenanceDeps,
  fn: (tenantId: string) => Promise<void>,
): Promise<void> {
  const controlPlane = need(deps.controlPlane, 'the control plane');
  let after: string | undefined;
  do {
    const page = await controlPlane.listCellTenants(after ? { after } : {});
    for (const tenantId of page.tenantIds) await fn(tenantId);
    after = page.next ?? undefined;
  } while (after);
}

/** Cell-wide housekeeping and audit chaining on the `maintenance` queue. */
export function createMaintenanceHandler(deps: MaintenanceDeps = {}): JobHandler {
  return async (envelope, { prisma, logger }) => {
    switch (envelope.topic) {
      case OUTBOX_PARTITIONS_TOPIC: {
        const result = await outbox.maintainPartitions(prisma);
        const auditMade = await audit.maintainPartitions(prisma);
        const historyMade = await fieldHistory.maintainPartitions(prisma);
        if (
          result.created.length ||
          result.dropped.length ||
          auditMade.length ||
          historyMade.length
        )
          logger.info(
            { ...result, auditCreated: auditMade, fieldHistoryCreated: historyMade },
            'partitions maintained',
          );
        return;
      }
      case AUDIT_CHAIN_TOPIC: {
        if (!envelope.tenantId) throw new Error(`${envelope.topic} needs a tenant`);
        const result = await chainTenant(deps, envelope.tenantId);
        if (result.gaps.length)
          logger.warn({ gaps: result.gaps.map(String) }, 'audit gaps declared');
        return;
      }
      case AUDIT_VERIFY_TOPIC: {
        // With a tenant: that tenant now (on demand, the runbook). Without: every tenant (daily).
        if (envelope.tenantId) {
          await verifyTenant(deps, prisma, logger, envelope.tenantId);
          return;
        }
        await eachTenant(deps, (tenantId) => verifyTenant(deps, prisma, logger, tenantId));
        return;
      }
      case CURRENCY_RECALC_TOPIC: {
        const { tenantId } = envelope;
        if (!tenantId) throw new Error(`${envelope.topic} needs a tenant`);
        const updated = await recalculateCorporateAmounts(
          (fn) => withTenant(prisma, { tenantId }, fn, { timeoutMs: 120_000 }),
          envelope.payload,
        );
        logger.info({ tenantId, updated }, 'corporate amounts recalculated');
        return;
      }
      case RECYCLE_PURGE_TOPIC: {
        const now = new Date();
        const purge = async (tenantId: string) => {
          const purged = await purgeTenant(prisma, tenantId, now);
          if (purged) logger.info({ tenantId, purged }, 'recycle bin purged');
        };
        if (envelope.tenantId) await purge(envelope.tenantId);
        else await eachTenant(deps, purge);
        return;
      }
      default:
        throw new Error(`unknown maintenance job ${envelope.topic}`);
    }
  };
}

/** Partition housekeeping only (no audit dependencies). */
export const maintenanceHandler = createMaintenanceHandler();

const system = (topic: string) => ({
  name: topic,
  data: {
    eventId: topic,
    tenantId: null,
    topic,
    aggregateType: null,
    aggregateId: null,
    payload: {},
    createdAt: new Date(0).toISOString(),
  },
});

/** Schedule the recurring maintenance jobs (idempotent: safe from every worker replica). */
export async function scheduleMaintenance(queues: QueueSet): Promise<void> {
  const q = queues.get('maintenance');
  await q.upsertJobScheduler(
    OUTBOX_PARTITIONS_TOPIC,
    { every: 3_600_000, immediately: true },
    system(OUTBOX_PARTITIONS_TOPIC),
  );
  await q.upsertJobScheduler(
    AUDIT_VERIFY_TOPIC,
    { pattern: '17 3 * * *' },
    system(AUDIT_VERIFY_TOPIC),
  );
  await q.upsertJobScheduler(
    RECYCLE_PURGE_TOPIC,
    { pattern: '41 2 * * *' },
    system(RECYCLE_PURGE_TOPIC),
  );
}
