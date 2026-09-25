import { startTestPostgres, type TestPostgresServer } from '@sm/db/testing';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    pgServerAdminUrl: string;
    redisUrl: string;
  }
}

let postgres: TestPostgresServer | undefined;
let valkey: StartedTestContainer | undefined;

/** Postgres (TEST_PG_SERVER_ADMIN_URL or Testcontainers) and Valkey (TEST_REDIS_URL or Testcontainers). */
export async function setup(project: TestProject): Promise<void> {
  postgres = await startTestPostgres();
  let redisUrl = process.env['TEST_REDIS_URL'];
  if (!redisUrl) {
    valkey = await new GenericContainer('valkey/valkey:8-alpine').withExposedPorts(6379).start();
    redisUrl = `redis://${valkey.getHost()}:${String(valkey.getMappedPort(6379))}`;
  }
  project.provide('pgServerAdminUrl', postgres.adminUrl);
  project.provide('redisUrl', redisUrl);
}

export async function teardown(): Promise<void> {
  await valkey?.stop();
  await postgres?.stop();
}
