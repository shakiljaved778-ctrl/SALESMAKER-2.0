import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { ensureTestCellRoles } from './cell-database.js';

export interface TestPostgresServer {
  adminUrl: string;
  stop(): Promise<void>;
}

/**
 * A Postgres 16 server for integration tests, with the cell roles created once. Reuses
 * TEST_PG_SERVER_ADMIN_URL (e.g. the docker compose server) when set; otherwise starts a
 * throwaway Testcontainers instance.
 */
export async function startTestPostgres(): Promise<TestPostgresServer> {
  let container: StartedPostgreSqlContainer | undefined;
  let adminUrl = process.env['TEST_PG_SERVER_ADMIN_URL'];
  if (!adminUrl) {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    adminUrl = container.getConnectionUri();
  }
  await ensureTestCellRoles(adminUrl);
  return {
    adminUrl,
    async stop() {
      await container?.stop();
    },
  };
}
