import type pg from 'pg';

export interface RlsViolation {
  table: string;
  problem: string;
}

interface TableRow {
  table: string;
  enabled: boolean;
  forced: boolean;
}

interface PolicyRow {
  table: string;
  policyname: string;
  permissive: string;
  roles: string[];
  cmd: string;
  qual: string | null;
  with_check: string | null;
}

const TENANT_PREDICATE = /\(?tenant_id = app_current_tenant_id\(\)\)?/;

/**
 * CI gate `db:rls-audit` (§3.5). Every table (including partitions) with a `tenant_id`
 * column must have RLS enabled **and forced**, exactly one policy named `tenant_isolation`
 * that applies to all commands and roles and pins both USING and WITH CHECK to
 * app_current_tenant_id(), and no additional permissive policy that could widen access.
 * Tables without tenant_id (control-plane or global data such as `currency`) are out of scope;
 * `allowList` exists for the rare tenant_id table that is deliberately exempt (it needs an ADR).
 */
export async function auditRowLevelSecurity(
  client: pg.Client | pg.PoolClient,
  allowList: readonly string[] = [],
): Promise<RlsViolation[]> {
  const tables = await client.query<TableRow>(`
    SELECT format('%I.%I', n.nspname, c.relname) AS table,
           c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'partman')
      AND n.nspname NOT LIKE 'pg\\_%'
    ORDER BY 1`);

  const policies = await client.query<PolicyRow>(`
    SELECT format('%I.%I', schemaname, tablename) AS table, policyname, permissive,
           roles::text[] AS roles, cmd, qual, with_check
    FROM pg_policies`);

  const byTable = new Map<string, PolicyRow[]>();
  for (const p of policies.rows) {
    byTable.set(p.table, [...(byTable.get(p.table) ?? []), p]);
  }

  const violations: RlsViolation[] = [];
  for (const t of tables.rows) {
    if (allowList.includes(t.table)) continue;
    const report = (problem: string) => violations.push({ table: t.table, problem });
    if (!t.enabled) report('row level security is not enabled');
    if (!t.forced) report('row level security is not forced (owner would bypass it)');

    const tablePolicies = byTable.get(t.table) ?? [];
    const isolation = tablePolicies.find((p) => p.policyname === 'tenant_isolation');
    if (!isolation) {
      report('missing tenant_isolation policy');
    } else {
      if (isolation.permissive !== 'PERMISSIVE') report('tenant_isolation must be PERMISSIVE');
      if (isolation.cmd !== 'ALL') report(`tenant_isolation applies to ${isolation.cmd}, not ALL`);
      if (isolation.roles.join(',') !== 'public')
        report('tenant_isolation must apply to all roles');
      if (!TENANT_PREDICATE.test(isolation.qual ?? ''))
        report('tenant_isolation USING is not tenant_id = app_current_tenant_id()');
      if (!TENANT_PREDICATE.test(isolation.with_check ?? '')) {
        report('tenant_isolation WITH CHECK is not tenant_id = app_current_tenant_id()');
      }
    }
    for (const extra of tablePolicies) {
      if (extra.policyname !== 'tenant_isolation' && extra.permissive === 'PERMISSIVE') {
        report(`extra permissive policy "${extra.policyname}" could widen tenant access`);
      }
    }
  }
  return violations;
}
