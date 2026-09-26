# Sharing

Spec: §6.3, §6.4 · ADR: 0007 · Code: `packages/query-engine/src/sharing-*.ts`, `packages/db/src/sharing.ts`,
`apps/api/src/sharing`, `apps/api/src/setup/sharing-setup.service.ts`, `apps/worker/src/sharing.ts` · Tables:
[ERD](../spec/ERD.md#groups-queues-and-sharing-p01)

Sharing decides **which records** a user may read, edit, or fully control (transfer, share, delete). It composes
with [permissions](permissions.md): the object permission must allow the action, and sharing must reach the record.

## Sources of access

| Source                    | How it works                                                                                                                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Org-wide default**      | Per object: Private, Public Read, Public Read/Write, or Controlled by Parent (`org_wide_default`, catalogue default otherwise). Public models short-circuit the predicate.                                                                         |
| **Ownership**             | The owner always has Full access. A record owned by a queue gives every queue member Full access (not flowing up the hierarchy).                                                                                                                   |
| **Hierarchy**             | With "grant access using hierarchies" (fixed on for standard objects), a viewer sees records owned by users in org units strictly below theirs and by their direct reports (`manager_id`). Peers in the same unit do not see each other's records. |
| **Sharing rules**         | Owner-based (records owned by members of a group or unit) or criteria-based (records matching a filter tree), shared with a group, queue, unit, or unit and subordinates at Read or Read/Write. Written to `record_share` with reason `RULE`.      |
| **Manual shares**         | By a user with Full access to the record; reason `MANUAL`.                                                                                                                                                                                         |
| **Controlled by Parent**  | Access to a child (contact, activity, quote) is access to any of its parents at the same level, up to three levels; a child without a parent falls back to owner, hierarchy and shares.                                                            |
| **View All / Modify All** | Object or data-wide permissions bypass sharing at their level.                                                                                                                                                                                     |

## Data structures

- **`user_visibility_closure`** — per viewer, every owner whose records hierarchy access shows them (themselves, users
  below them, direct reports, their queues). Written only by `rebuild_user_visibility()` (schema owner, set-based,
  serialised per tenant). Setup changes rebuild exactly the affected viewers in the same transaction
  (`users_above_org_units`) or emit `sharing.visibility_changed` for the worker.
- **Principals** — a user's ids a share can name: themselves, their groups and queues (transitive), their own org
  unit (matches `ORG_UNIT` shares) and their unit plus ancestors (matches `ORG_UNIT_AND_SUBORDINATES` shares).
  Cached in Valkey under the tenant's `permVersion`.
- **`record_share`** — LIST-partitioned by object; unique per (record, principal, reason, `source_id`), so
  recalculating a rule is an exact delete-and-insert of its own shares.

## The predicate

`sharingPredicate(ctx, object, alias, level)` returns a plain Kysely SQL expression that is true exactly for the rows
the user may access at `level`: `owner = me OR owner IN (closure) OR EXISTS (share for my principals at ≥ level)`,
plus the parent recursion. It composes with any other `WHERE` and uses the `(tenant_id, …)` indexes. The Query
Engine (P02) injects it into every CRM read; nothing else may read CRM tables.

## Keeping it current

Every membership, placement or rule change bumps `permVersion` (principal caches retire) and either rebuilds
visibility synchronously or queues work. Rule create/update creates a `job_run` and emits `sharing.rule_changed`;
the worker recalculates in batches and reports progress, which Setup polls. Group membership changes and unit moves
queue recalculation of the active owner-based rules. Changes reach everyone within about a minute (ADR-0007).
Until P02 creates the object tables, a rule's recalculation finds no records and succeeds with 0 of 0.

## Performance (P01 T22)

At bank scale (930 users, org depth 3, 500k records, 25k shares) the closure is 5,408 rows, a full rebuild takes
134 ms and a leaf-unit rebuild 22 ms; a principal set costs 9 ms computed and 0.5 ms from cache; a 50-row list page
with the predicate is at worst 38 ms p95 (budget 400 ms). Rerun with `pnpm --filter @sm/api perf:sharing` after
`pnpm db:seed --scenario=bank`; details in [P01-notes](../phases/P01-notes.md).

## Tests

`packages/query-engine/test` (predicate and rule semantics on fixture tables), `apps/api/test/permission-matrix.test.ts`,
the Setup sharing suites, and `apps/worker/test/sharing.test.ts`.
