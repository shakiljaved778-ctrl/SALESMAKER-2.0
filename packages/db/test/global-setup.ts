import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

import { ensureTestCellRoles } from '../src/testing/cell-database.js';

declare module 'vitest' {
  export interface ProvidedContext {
    pgServerAdminUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

/**
 * Integration tests need a Postgres 16 server with the §3.2 extensions. Set
 * TEST_PG_SERVER_ADMIN_URL to reuse a running server (e.g. docker compose); otherwise a
 * throwaway Testcontainers instance is started for the run.
 */
export async function setup(project: TestProject): Promise<void> {
  let url = process.env['TEST_PG_SERVER_ADMIN_URL'];
  if (!url) {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    url = container.getConnectionUri();
  }
  await ensureTestCellRoles(url);
  project.provide('pgServerAdminUrl', url);
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
