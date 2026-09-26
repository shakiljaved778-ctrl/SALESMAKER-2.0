import { generateKeyPairSync, randomBytes } from 'node:crypto';

import { withTenant, type TenantTransaction } from '@sm/db';
import { createTestCellDatabase, type TestCellDatabase } from '@sm/db/testing';
import { createLogger } from '@sm/server-kit';
import { FakeControlPlane } from '@sm/testing';
import { inject } from 'vitest';
import type { z } from 'zod';

import { WorkerConfigSchema, type WorkerConfig } from '../src/config.js';
import type { Handlers } from '../src/jobs.js';
import { createWorker, type CellWorker } from '../src/worker.js';

export const SERVICE_KEY = generateKeyPairSync('ed25519').privateKey.export({
  type: 'pkcs8',
  format: 'pem',
});

export interface TestWorker extends CellWorker {
  db: TestCellDatabase;
  config: WorkerConfig;
  controlPlane: FakeControlPlane;
  /** Register a tenant with the (fake) control plane and return its id. */
  tenant(slug: string): Promise<string>;
  inTenant<T>(tenantId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T>;
  dispose(): Promise<void>;
}

/** A worker on a fresh cell database and its own BullMQ key prefix in the shared Valkey. */
export async function startTestWorker(
  options: { handlers?: Handlers; config?: Partial<z.input<typeof WorkerConfigSchema>> } = {},
): Promise<TestWorker> {
  const db = await createTestCellDatabase(inject('pgServerAdminUrl'));
  const config = WorkerConfigSchema.parse({
    CELL_ID: 'eu-central-1',
    CELL_DATABASE_URL: db.appUrl,
    CELL_AUDIT_DATABASE_URL: db.auditUrl,
    REDIS_URL: inject('redisUrl'),
    CONTROL_API_BASE_URL: 'http://control-api.test',
    CELL_SERVICE_PRIVATE_KEY_PEM: SERVICE_KEY,
    LOG_LEVEL: 'silent',
    QUEUE_PREFIX: `test-${randomBytes(4).toString('hex')}`,
    JOB_BACKOFF_MS: 10,
    RELAY_SWEEP_SECONDS: 3600,
    ...options.config,
  });
  const controlPlane = new FakeControlPlane();
  const worker = await createWorker(config, {
    controlPlane,
    ...(options.handlers ? { handlers: options.handlers } : {}),
    logger: createLogger({ service: 'test-worker', level: 'silent' }),
  });
  return {
    ...worker,
    db,
    config,
    controlPlane,
    async tenant(slug) {
      const reserved = await controlPlane.reserveTenant(slug, {
        slug,
        name: slug,
        ownerEmailHmac: 'hmac',
      });
      return reserved.tenantId;
    },
    inTenant: (tenantId, fn) => withTenant(worker.prisma, { tenantId }, fn),
    async dispose() {
      await worker.stop();
      await db.drop();
    },
  };
}

/** Poll until `check` returns a truthy value (or throw after `timeoutMs`). */
export async function eventually<T>(
  check: () => Promise<T | undefined | false>,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 50));
  }
}
