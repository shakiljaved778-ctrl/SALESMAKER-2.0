# ADR-0001: Multi-tenant shared Postgres with forced row-level security

- **Status:** Accepted (locked decision #6 (and #3) in MASTER_SPEC §1.4)
- **Date:** 2026-09-25
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §3.5, §6.4

## Context

SalesMaker is self-serve multi-tenant SaaS covering 5 to 1,000-user organisations, with thousands of tenants per cell. Tenant isolation is the top product principle (§1.5).

## Decision

All tenants share one PostgreSQL 16 database per regional cell. Every tenant-owned table carries `tenant_id uuid NOT NULL`, which leads its PK or a composite unique index and every secondary index. RLS is **enabled and forced** through `enable_tenant_rls()`, with a `tenant_isolation` policy on `current_setting('app.tenant_id', true)`. The runtime role `sm_app` is not the table owner and has no BYPASSRLS. All tenant access goes through `withTenant()`, which sets the transaction-local `app.tenant_id` and `app.user_id`. The CI gate `db:rls-audit` fails on any `tenant_id` table without forced RLS. Cross-tenant tests assert 404 on every endpoint. RLS covers tenant isolation only; in-tenant sharing is enforced by the Permission Engine through the Query Engine.

## Consequences

- Cheap onboarding, and one schema/migration path for all tenants.
- The database itself backstops application bugs.
  − Noisy neighbours need per-tenant fairness (BullMQ groups, rate limits, statement timeouts).
  − Every query pays the RLS predicate, so indexes must lead with `tenant_id`.
  − Enterprise isolation is handled by a dedicated cell (ADR-0005), not a dedicated schema.

## Alternatives rejected

Schema-per-tenant (migration fan-out and catalogue bloat at 2,000+ tenants); database-per-tenant (cost and ops burden); application-only filtering without RLS (one missed `WHERE` leaks data).

> Changing this decision requires the owner's approval (§0.3) and a new superseding ADR.
