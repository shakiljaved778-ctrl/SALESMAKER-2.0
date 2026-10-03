# Query Engine

Spec: §3.8, §6.4, §6.5 · ADR: 0004, 0007 · Code: `packages/query-engine` (`@sm/query-engine`): `smq.ts`,
`filter.ts`, `sharing-predicate.ts`; API: `POST /v1/query`, `GET /v1/records/{object}`, list views

Every CRM read goes through here (golden rule 3). It turns a JSON query (SMQ) into one Kysely statement that runs
inside the caller's tenant transaction, with sharing and field-level security applied in SQL.

## SMQ

```json
{
  "object": "lead",
  "fields": ["last_name", "company", "owner_id.name"],
  "where": { "and": [{ "field": "status", "op": "eq", "value": "working" }] },
  "sort": [{ "field": "last_name", "direction": "asc" }],
  "limit": 50,
  "cursor": "…"
}
```

- **Validation.** ≤ 100 fields or lookup paths, ≤ 3 sort keys, a filter tree (`and`/`or`/`not`, operators per
  type, `$me` for the caller), limit ≤ the caller's maximum (200 for lists, 2,000 for `/v1/query`), and the
  recently-viewed scope.
- **Resolution as the caller.** Standard fields are columns, custom fields casts out of `custom`, lookup paths (≤ 3
  relationships) LEFT JOINs whose target carries its own sharing predicate and `deleted_at IS NULL`. Lookups come
  back as `{ id, name, object }`, with a null name when the caller cannot see the target.
- **FLS.** A hidden field is dropped from the projection; in a filter or sort it is `unknown_field`, exactly like a
  field that does not exist, so its existence is not disclosed.
- **Exact values.** Numbers, dates and timestamps are projected as text, so cursors round-trip exactly.
- **Keyset pagination.** `ASC NULLS LAST` / `DESC NULLS FIRST` with the id last in the same direction; the cursor
  condition is a null-aware OR-chain. One `(tenant_id, field, id)` index serves both directions.
- **Counts** stop at 100,001 and show as "100k+".

## Sharing in SQL

`sharingPredicate(ctx, object, alias, level)` is ANDed into every statement: owner is me, or an owner in my
visibility closure, or a share for my principals at the level, or (Controlled by Parent) access to a parent. Public
models short-circuit it; View All / Modify All skip it. See [sharing](sharing.md).

Its owner and share arms are arrays (`owner_id = ANY (…)`, `id = ANY (shared ids)`), so the planner can combine
the `(tenant_id, owner_id)` index and the primary key in a BitmapOr instead of scanning the table. API requests
inline the viewer's visibility closure, read once per request, so the planner knows whether it is planning for a rep
who sees two owners or a director who sees hundreds; worker jobs keep the per-statement subquery. Every tenant
transaction runs with `jit = off`.

## Indexes it relies on

Each object table has `(tenant_id, owner_id)`, and for every sortable standard field both `(tenant_id, field, id)`
(admins, broad views) and `(tenant_id, owner_id, field, id)` (a rep's own records in any order). Related-list
lookups are indexed. Plans and timings at 500k leads (every list budget met, worst p95 228 ms) are in
[P02-notes](../phases/P02-notes.md) (T28); rerun with `pnpm --filter @sm/api perf:records`.

## Tests

`packages/query-engine/test/smq.test.ts` and `filter.test.ts` (validation, FLS, keyset over nulls, lookups,
counts), `sharing-predicate.test.ts` and `sharing-rules.test.ts`; the API's records and list-view suites; the
permission matrix in `apps/api/test/permission-matrix.test.ts`. Coverage gate ≥ 90%.
