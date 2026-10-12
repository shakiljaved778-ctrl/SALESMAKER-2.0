import type { TestProject } from 'vitest/node';

import { startTestPostgres, type TestPostgresServer } from '@sm/db/testing';

declare module 'vitest' {
  export interface ProvidedContext {
    pgServerAdminUrl: string;
  }
}

let server: TestPostgresServer | undefined;

export async function setup(project: TestProject): Promise<void> {
  server = await startTestPostgres();
  project.provide('pgServerAdminUrl', server.adminUrl);
}

export async function teardown(): Promise<void> {
  await server?.stop();
}
