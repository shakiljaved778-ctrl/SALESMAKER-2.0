const EXTENSIONS = ['pgcrypto', 'pg_trgm', 'citext', 'btree_gin', 'vector'];

/**
 * Idempotently create roles, schema ownership, grants and extensions on a cell database.
 * @param {import('pg').Client} client connected as an admin role
 * @param {{ migratorPassword: string, appPassword: string, reportsPassword: string }} passwords
 */
export async function bootstrapCell(client, { migratorPassword, appPassword, reportsPassword }) {
  const { rows } = await client.query('SELECT current_database() AS db');
  const db = rows[0].db;

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
    // Break-glass support role: NOLOGIN until time-boxed access is granted and audited (§6.7).
    ['sm_support', null, 'NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE'],
  ];

  for (const [name, password, attributes] of roles) {
    const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
    const verb = exists.rowCount ? 'ALTER' : 'CREATE';
    const pwd = password ? ` PASSWORD ${client.escapeLiteral(password)}` : '';
    await client.query(`${verb} ROLE ${name} ${attributes}${pwd}`);
  }

  await client.query('CREATE SCHEMA IF NOT EXISTS public');
  for (const ext of EXTENSIONS) {
    await client.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
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
    `GRANT CONNECT ON DATABASE ${ident} TO sm_migrator, sm_app, sm_readonly_reports, sm_support`,
  );
  await client.query(`GRANT CREATE ON DATABASE ${ident} TO sm_migrator`);
  await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await client.query('ALTER SCHEMA public OWNER TO sm_migrator');
  await client.query('GRANT USAGE ON SCHEMA public TO sm_app, sm_readonly_reports, sm_support');
}
