import { createCellPrisma, disposeCellPrisma, type CellPrisma } from '@sm/db';
import {
  createLogger,
  HttpControlPlane,
  importEd25519PrivateKey,
  type ControlPlane,
} from '@sm/server-kit';
import type { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';

import type { WorkerConfig } from './config.js';
import { startConsumers } from './consumers.js';
import { FairScheduler } from './fairness.js';
import type { Handlers } from './jobs.js';
import { maintenanceHandler, scheduleMaintenance } from './maintenance.js';
import { createQueues, type QueueSet } from './queues.js';
import { OutboxRelay } from './relay.js';

/** Consumers registered in this phase; later phases add theirs (sharing in T08, …). */
export const HANDLERS: Handlers = { maintenance: maintenanceHandler };

export interface WorkerDeps {
  controlPlane?: Pick<ControlPlane, 'listCellTenants'>;
  handlers?: Handlers;
  logger?: Logger;
}

export interface CellWorker {
  prisma: CellPrisma;
  redis: Redis;
  queues: QueueSet;
  fairness: FairScheduler;
  relay: OutboxRelay;
  logger: Logger;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Build the worker from config. Connections open now; nothing is consumed or relayed until `start()`. */
export async function createWorker(
  config: WorkerConfig,
  deps: WorkerDeps = {},
): Promise<CellWorker> {
  const logger = deps.logger ?? createLogger({ service: 'sm-worker', level: config.LOG_LEVEL });
  const prisma = createCellPrisma(config.CELL_DATABASE_URL, { maxConnections: config.DB_POOL_MAX });
  // BullMQ blocks on this connection's duplicates, which must never give up on a command.
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const queues = createQueues(redis, config.QUEUE_PREFIX, {
    attempts: config.JOB_ATTEMPTS,
    backoffMs: config.JOB_BACKOFF_MS,
  });
  const fairness = new FairScheduler(redis, config.QUEUE_PREFIX);
  const controlPlane =
    deps.controlPlane ??
    new HttpControlPlane(
      config.CONTROL_API_BASE_URL,
      config.CELL_ID,
      await importEd25519PrivateKey(config.CELL_SERVICE_PRIVATE_KEY_PEM),
      config.CELL_SERVICE_KID,
    );
  const relay = new OutboxRelay({
    prisma,
    queues,
    fairness,
    controlPlane,
    logger,
    batch: config.RELAY_BATCH,
    listenUrl: config.CELL_DATABASE_LISTEN_URL ?? config.CELL_DATABASE_URL,
    sweepSeconds: config.RELAY_SWEEP_SECONDS,
  });
  let workers: Worker[] = [];

  return {
    prisma,
    redis,
    queues,
    fairness,
    relay,
    logger,
    async start() {
      workers = startConsumers(deps.handlers ?? HANDLERS, {
        connection: redis,
        prefix: config.QUEUE_PREFIX,
        concurrency: config.WORKER_CONCURRENCY,
        prisma,
        queues,
        fairness,
        logger,
      });
      await scheduleMaintenance(queues);
      await relay.start();
      logger.info({ queues: workers.map((w) => w.name) }, 'worker started');
    },
    async stop() {
      await relay.stop();
      await Promise.all(workers.map((w) => w.close()));
      await queues.close();
      redis.disconnect();
      await disposeCellPrisma(prisma);
    },
  };
}
