# ADR-0030: Indexes on custom fields of standard objects

- **Status:** Accepted (Q11, owner approval of the P02 plan, CHANGELOG_SPEC v1.4); build mechanism open (Q30)
- **Date:** 2026-09-27
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §3.3, §4.1, §5.2, §11.2

## Context

Custom fields of standard objects live in each record's `custom jsonb` (§5.2) on tables shared by every tenant of a
cell. Admins mark some of them as filtered and sorted on often ("indexed"). A table-wide index on a jsonb path would
cover every tenant's unrelated keys; one per tenant per field multiplies quickly (2,000 tenants per cell). Building
any index on a shared table without `CONCURRENTLY` blocks writes for every tenant while it runs.

## Decision

- An indexed custom field gets a **per-tenant partial expression index**:
  `(tenant_id, ((custom->>'x__c')::<type>), id) WHERE tenant_id = '<tenant>' AND deleted_at IS NULL`.
- Requests are rows in `custom_field_index` (PENDING → READY | FAILED), **capped at 10 per object per tenant** until
  plans (P05) set the cap. Deleting the field drops its index request.
- A **worker job** builds them `CONCURRENTLY`, one at a time per cell, from validated identifiers only.
- Standard tables are not partitioned, so this works in PG16; the partitioned `custom_record` table (custom
  objects) is decided in P11. Tenants that outgrow this move to promoted typed columns or the OpenSearch provider
  (P12).

**Open (Q30):** `CREATE INDEX CONCURRENTLY` cannot run inside a transaction, so it cannot run in a `SECURITY DEFINER`
function as Q11 first proposed. The proposal is a dedicated `sm_migrator` connection in the worker; the
alternatives are a function without `CONCURRENTLY` (accepting the write lock) or deferring to P11. Until the owner
answers, requests are recorded as PENDING and nothing is built.

## Consequences

- Index count grows with tenants × indexed fields; the cap and P12's provider bound it.
- Queries on an indexed custom field use the same keyset plans as standard fields once READY.
  − A PENDING index means slower filters on that field at scale until Q30 is answered.

## Alternatives rejected

A GIN index on all of `custom` (large, poor for sorting and ranges); promoted columns for every custom field (DDL per
field on shared tables); no custom-field indexes before P11 (lists on large tenants would scan).
