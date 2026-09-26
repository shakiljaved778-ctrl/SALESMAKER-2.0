const EXTENSIONS = ['pgcrypto', 'pg_trgm', 'citext', 'btree_gin', 'vector'];

/**
 * Idempotently create or update the five cluster-wide cell roles.
 * @param {import('pg').Client} client connected as an admin role
 * @param {{ migratorPassword: string, appPassword: string, reportsPassword: string, auditPassword: string }} passwords
 */
export async function ensureCellRoles(
  client,
  { migratorPassword, appPassword, reportsPassword, auditPassword },
) {
  const roles = [
    // Owner of every table; runs DDL. Never used by the running application.
    ['sm_migrator', migratorPassword, 'LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE'],
    // Runtime role: not an owner, no BYPASSRLS, so forced RLS always applies.
    ['sm_app', appPassword, 'LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE'],
    // Read replica reporting role; RLS applies.
    [
      'sm_readonly_reports',
      reportsPassword,
      'LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE',
    ],
    // Audit chain writer (ADR-0008 addendum): may set an audit row's hash exactly once, nothing else.
    ['sm_audit', auditPassword, 'LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE'],
    // Break-glass support role: NOLOGIN until time-boxed access is granted and audited (§6.7).
    ['sm_support', null, 'NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE'],
  ];

  for (const [name, password, attributes] of roles) {
    const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
    const verb = exists.rowCount ? 'ALTER' : 'CREATE';
    const pwd = password ? ` PASSWORD ${client.escapeLiteral(password)}` : '';
    await client.query(`${verb} ROLE ${name} ${attributes}${pwd}`);
  }
}

/**
 * Idempotently bootstrap a cell database: roles (unless `manageRoles` is false, e.g. when
 * roles were already created cluster-wide), extensions, schema ownership and grants.
 * @param {import('pg').Client} client connected as an admin role to the cell database
 * @param {{ migratorPassword: string, appPassword: string, reportsPassword: string, auditPassword: string }} passwords
 * @param {{ manageRoles?: boolean }} [options]
 */
export async function bootstrapCell(client, passwords, { manageRoles = true } = {}) {
  if (manageRoles) await ensureCellRoles(client, passwords);
  const { rows } = await client.query('SELECT current_database() AS db');
  const db = rows[0].db;

  // Extensions live in their own schema so a reset of `public` (e.g. Prisma's shadow database
  // for the drift check) never drops them; the database search_path makes their types visible.
  await client.query('CREATE SCHEMA IF NOT EXISTS public');
  await client.query('CREATE SCHEMA IF NOT EXISTS extensions');
  for (const ext of EXTENSIONS) {
    await client.query(`CREATE EXTENSION IF NOT EXISTS ${ext} SCHEMA extensions`);
  }
  const partman = await client.query(
    "SELECT 1 FROM pg_available_extensions WHERE name = 'pg_partman'",
  );
  if (partman.rowCount) {
    await client.query('CREATE SCHEMA IF NOT EXISTS partman');
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman');
  }

  const ident = client.escapeIdentifier(db);
  await client.query(`REVOKE ALL ON DATABASE ${ident} FROM PUBLIC`);
  await client.query(
    `GRANT CONNECT ON DATABASE ${ident} TO sm_migrator, sm_app, sm_readonly_reports, sm_support, sm_audit`,
  );
  await client.query(`GRANT CREATE ON DATABASE ${ident} TO sm_migrator`);
  await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await client.query('ALTER SCHEMA public OWNER TO sm_migrator');
  await client.query(
    'GRANT USAGE ON SCHEMA public TO sm_app, sm_readonly_reports, sm_support, sm_audit',
  );
  await client.query(
    'GRANT USAGE ON SCHEMA extensions TO sm_migrator, sm_app, sm_readonly_reports, sm_support, sm_audit',
  );
  await client.query(`ALTER DATABASE ${ident} SET search_path = public, extensions`);
}
