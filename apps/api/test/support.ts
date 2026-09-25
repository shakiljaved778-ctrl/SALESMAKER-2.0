import { randomBytes } from 'node:crypto';

import { createTestCellDatabase, type TestCellDatabase } from '@sm/db/testing';
import { inject } from 'vitest';

import { createApiApp, type ApiApp } from '../src/app.js';
import { ApiConfigSchema, type ApiConfig } from '../src/config.js';

export interface TestApi extends ApiApp {
  db: TestCellDatabase;
  config: ApiConfig;
  dispose(): Promise<void>;
}

/** A real API on a fresh cell database and a Valkey namespace; nothing is mocked. */
export async function startTestApi(overrides: Partial<ApiConfig> = {}): Promise<TestApi> {
  const db = await createTestCellDatabase(inject('pgServerAdminUrl'));
  const config = ApiConfigSchema.parse({
    CELL_ID: 'eu-central-1',
    CELL_DATABASE_URL: db.appUrl,
    REDIS_URL: inject('redisUrl'),
    CONTROL_API_BASE_URL: 'http://control-api.test',
    LOG_LEVEL: 'silent',
    // Unique buckets per test app: every app.inject() request comes from 127.0.0.1.
    RATE_LIMIT_NAMESPACE: `rl:test:${randomBytes(6).toString('hex')}`,
    ...overrides,
  });
  const api = await createApiApp(config);
  return {
    ...api,
    db,
    config,
    async dispose() {
      await api.close();
      await db.drop();
    },
  };
}
