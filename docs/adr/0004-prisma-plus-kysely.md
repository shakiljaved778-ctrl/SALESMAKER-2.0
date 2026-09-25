# ADR-0004: Prisma for schema and migrations, Kysely for dynamic metadata SQL

- **Status:** Accepted (locked decision #24 in MASTER_SPEC §1.4)
- **Date:** 2026-09-25
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §3.2, §3.5, §3.8

## Context
Platform tables are static and suit a typed ORM. CRM queries are metadata-driven (custom fields in JSONB, dynamic filters, sharing predicates, aggregates) and cannot be expressed statically.

## Decision
**Prisma** owns the schema, migrations and platform-table access. **Kysely** builds all dynamic SQL in the Query Engine and RecordService. Both run on the **same connection inside the tenant transaction** opened by `withTenant()`: Kysely executes through Prisma's interactive transaction via a Prisma-backed Kysely driver, so `set_config` applies to both. Raw DDL that Prisma cannot model (RLS policies, partitions, expression indexes) goes into SQL migrations. PgBouncer runs in transaction mode with prepared statements handled accordingly.

## Consequences
+ Typed static access, plus a safe query builder for the dynamic cases.
− Two query tools to learn, and the Prisma↔Kysely bridge must be proven in P00 (a spike with an RLS test).
− Prisma's partitioned-table support is limited, so partitions are managed in SQL migrations and pg_partman.

## Alternatives rejected
Prisma only (`$queryRawUnsafe` string-building for dynamic SQL is an injection risk); Kysely only (loses Prisma migrations/DX); Drizzle (viable, but not the locked choice).

> Changing this decision requires the owner's approval (§0.3) and a new superseding ADR.
