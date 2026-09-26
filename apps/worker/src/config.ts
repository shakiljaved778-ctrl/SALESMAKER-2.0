import { readFileSync } from 'node:fs';

import { z } from 'zod';

/** Worker configuration, validated at startup. */
export const WorkerConfigSchema = z.object({
  CELL_ID: z.string().min(1),
  /** Runtime role (sm_app); queries run inside tenant transactions like the API's. */
  CELL_DATABASE_URL: z.url(),
  /**
   * A direct (non-PgBouncer) connection for LISTEN: notifications need a session, which
   * transaction pooling does not keep. Defaults to CELL_DATABASE_URL.
   */
  CELL_DATABASE_LISTEN_URL: z.url().optional(),
  /** sm_audit: sets audit rows' hashes (ADR-0008); nothing else connects with it. */
  CELL_AUDIT_DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  CONTROL_API_BASE_URL: z.url(),
  CELL_SERVICE_PRIVATE_KEY_PEM: z.string().includes('PRIVATE KEY'),
  CELL_SERVICE_KID: z.string().min(1).default('cell-1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(5),
  /** Redis key prefix for BullMQ (lets tests and environments share one Valkey). */
  QUEUE_PREFIX: z.string().min(1).default('sm'),
  /** Events the relay claims per tenant transaction. */
  RELAY_BATCH: z.coerce.number().int().min(1).max(1000).default(100),
  /** How often the relay sweeps every tenant for events a missed notification left behind. */
  RELAY_SWEEP_SECONDS: z.coerce.number().int().min(1).default(60),
  /** Concurrent jobs per queue in this process. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
  /** Tries per job before it moves to the dead-letter queue (exponential backoff between). */
  JOB_ATTEMPTS: z.coerce.number().int().min(1).max(25).default(5),
  JOB_BACKOFF_MS: z.coerce.number().int().min(0).default(1000),
});

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const path = env['CELL_SERVICE_PRIVATE_KEY_PATH'];
  return WorkerConfigSchema.parse({
    ...env,
    ...(path && !env['CELL_SERVICE_PRIVATE_KEY_PEM']
      ? { CELL_SERVICE_PRIVATE_KEY_PEM: readFileSync(path, 'utf8') }
      : {}),
  });
}
