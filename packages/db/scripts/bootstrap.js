// One-time, idempotent cell bootstrap run with an admin connection (§3.5):
// creates the five database roles, hands the public schema to sm_migrator and creates the
// extensions. Migrations then run as sm_migrator; the app connects as sm_app.
//
// Usage: CELL_ADMIN_DATABASE_URL=postgresql://postgres:…@host/salesmaker_cell pnpm db:bootstrap
// Role passwords come from SM_MIGRATOR_PASSWORD, SM_APP_PASSWORD, SM_REPORTS_PASSWORD and
// SM_AUDIT_PASSWORD
// (local defaults below are for development only; deployed cells use Secrets Manager).
import pg from 'pg';

import { bootstrapCell } from './bootstrap-lib.js';

const adminUrl = process.env.CELL_ADMIN_DATABASE_URL;
if (!adminUrl) {
  process.stderr.write('CELL_ADMIN_DATABASE_URL is required\n');
  process.exit(1);
}

const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
try {
  await bootstrapCell(client, {
    migratorPassword: process.env.SM_MIGRATOR_PASSWORD ?? 'sm_migrator_dev',
    appPassword: process.env.SM_APP_PASSWORD ?? 'sm_app_dev',
    reportsPassword: process.env.SM_REPORTS_PASSWORD ?? 'sm_reports_dev',
    auditPassword: process.env.SM_AUDIT_PASSWORD ?? 'sm_audit_dev',
  });
  process.stdout.write('cell bootstrap complete\n');
} finally {
  await client.end();
}
