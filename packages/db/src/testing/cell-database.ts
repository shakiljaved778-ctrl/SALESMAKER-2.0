import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import pg from 'pg';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface TestCellDatabase {
  name: string;
  adminUrl: string;
  migratorUrl: string;
  appUrl: string;
  reportsUrl: string;
  /** The audit chain writer (sm_audit). */
  auditUrl: string;
  drop(): Promise<void>;
}

type Passwords = typeof PASSWORDS;
interface BootstrapLib {
  ensureCellRoles(c: pg.Client, p: Passwords): Promise<void>;
  bootstrapCell(c: pg.Client, p: Passwords, o?: { manageRoles?: boolean }): Promise<void>;
}

async function loadBootstrap(): Promise<BootstrapLib> {
  return (await import(join(packageRoot, 'scripts', 'bootstrap-lib.js'))) as BootstrapLib;
}

// Same values as the local-dev defaults (.env.example): roles are cluster-wide, so tests run
// against the docker compose server must not change the passwords the dev app uses.
export const PASSWORDS = {
  migratorPassword: 'sm_migrator_dev',
  appPassword: 'sm_app_dev',
  reportsPassword: 'sm_reports_dev',
  auditPassword: 'sm_audit_dev',
};

function withDatabase(url: string, database: string, user?: string, password?: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (user) u.username = user;
  if (password) u.password = password;
  return u.toString();
}

/**
 * Create the cluster-wide cell roles once per test server (roles are shared by every database,
 * and concurrent CREATE ROLE statements from parallel test files would race).
 */
export async function ensureTestCellRoles(serverAdminUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: serverAdminUrl });
  await client.connect();
  try {
    await (await loadBootstrap()).ensureCellRoles(client, PASSWORDS);
  } finally {
    await client.end();
  }
}

/**
 * Create a fresh cell database on the server behind `serverAdminUrl`, bootstrap roles and run
 * every migration as sm_migrator, exactly as a deployed cell does. Used by integration tests.
 */
export async function createTestCellDatabase(serverAdminUrl: string): Promise<TestCellDatabase> {
  const name = `sm_test_${randomBytes(6).toString('hex')}`;
  const server = new pg.Client({ connectionString: serverAdminUrl });
  await server.connect();
  try {
    await server.query(`CREATE DATABASE ${name}`);
  } finally {
    await server.end();
  }

  const adminUrl = withDatabase(serverAdminUrl, name);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    // Roles are cluster-wide and created once by ensureTestCellRoles(); only per-database work here.
    await (await loadBootstrap()).bootstrapCell(admin, PASSWORDS, { manageRoles: false });
  } finally {
    await admin.end();
  }

  const migratorUrl = withDatabase(serverAdminUrl, name, 'sm_migrator', PASSWORDS.migratorPassword);
  const prismaCli = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');
  await run(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: packageRoot,
    env: { ...process.env, CELL_DATABASE_URL_MIGRATOR: migratorUrl },
  });

  return {
    name,
    adminUrl,
    migratorUrl,
    appUrl: withDatabase(serverAdminUrl, name, 'sm_app', PASSWORDS.appPassword),
    reportsUrl: withDatabase(
      serverAdminUrl,
      name,
      'sm_readonly_reports',
      PASSWORDS.reportsPassword,
    ),
    auditUrl: withDatabase(serverAdminUrl, name, 'sm_audit', PASSWORDS.auditPassword),
    async drop() {
      const c = new pg.Client({ connectionString: serverAdminUrl });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}
