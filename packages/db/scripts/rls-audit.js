// CLI for the `db:rls-audit` CI gate. Exits non-zero on any violation.
// Usage: RLS_AUDIT_DATABASE_URL=postgresql://…/salesmaker_cell pnpm db:rls-audit
import pg from 'pg';

import { auditRowLevelSecurity } from '../dist/rls-audit.js';

const url = process.env.RLS_AUDIT_DATABASE_URL ?? process.env.CELL_DATABASE_URL_MIGRATOR;
if (!url) {
  process.stderr.write('RLS_AUDIT_DATABASE_URL (or CELL_DATABASE_URL_MIGRATOR) is required\n');
  process.exit(2);
}
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const violations = await auditRowLevelSecurity(client);
  if (violations.length === 0) {
    process.stdout.write('db:rls-audit — all tenant tables have forced RLS and tenant_isolation\n');
  } else {
    for (const v of violations) process.stderr.write(`db:rls-audit ✗ ${v.table}: ${v.problem}\n`);
    process.exitCode = 1;
  }
} finally {
  await client.end();
}
