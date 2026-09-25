# Tenancy and row-level security

Spec: §3.4, §3.5 · ADRs: 0001, 0004, 0005 · Package: `@sm/db`

## Roles

| Role                  | Purpose                                                                 | Attributes                                      |
| --------------------- | ----------------------------------------------------------------------- | ----------------------------------------------- |
| `sm_migrator`         | Owns every table and runs migrations (DDL). Never used by running apps. | LOGIN, no superuser, no BYPASSRLS               |
| `sm_app`              | Runtime role for api, worker and realtime. Reads and writes rows only.  | LOGIN, not owner, **no BYPASSRLS**              |
| `sm_readonly_reports` | Read-replica reporting. RLS applies.                                    | LOGIN, SELECT only                              |
| `sm_support`          | Break-glass support (§6.7).                                             | **NOLOGIN** until access is granted and audited |

`pnpm db:bootstrap` (admin connection, idempotent) creates the roles and installs the extensions into
the `extensions` schema. It sets `search_path = public, extensions`, hands `public` to `sm_migrator` and
revokes `CREATE` from `PUBLIC`. Then `pnpm db:migrate` applies the Prisma migrations as `sm_migrator`.

## How a tenant table is protected

1. `tenant_id uuid NOT NULL` leads the primary key and every index.
2. The migration calls `SELECT enable_tenant_rls('<table>')`, which enables **and forces** RLS and creates
   the `tenant_isolation` policy: `USING` and `WITH CHECK` are both `tenant_id = app_current_tenant_id()`.
3. `app_current_tenant_id()` is `NULLIF(current_setting('app.tenant_id', true), '')::uuid`. The `NULLIF`
   matters because a pooled connection reports `''` rather than NULL once a transaction-local setting has
   ended. With no tenant set, no row matches.
4. `db:rls-audit` (a CI gate) fails if any table or partition with a `tenant_id` column lacks forced RLS or
   the exact `tenant_isolation` policy, or has another permissive policy that could widen access.

## Using it: `withTenant`

```ts
import { createCellPrisma, withTenant } from '@sm/db';

const prisma = createCellPrisma(process.env.CELL_DATABASE_URL); // sm_app
const users = await withTenant(prisma, { tenantId, userId }, async ({ prisma, kysely }) => {
  // Prisma for platform tables, Kysely for dynamic metadata SQL — same connection, same transaction.
  return kysely.selectFrom('user').select(['id', 'email']).execute();
});
```

`withTenant` validates the ids, opens an interactive transaction, and sets `app.tenant_id`, `app.user_id`
and `statement_timeout` (5 s by default) with `set_config(..., true)`. The Kysely instance is bound to that
transaction through `PrismaTransactionDialect` and refuses to open or end transactions of its own.

**PgBouncer (transaction mode) is safe:** every setting is transaction-local. `test/pgbouncer.test.ts`
routes 60 concurrent tenant transactions from three clients through two server connections, and checks
that no setting leaks to the next client. A mutation run with session-level settings fails that test.
