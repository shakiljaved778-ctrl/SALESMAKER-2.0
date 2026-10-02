# Records

Spec: §3.7, §4.1, §6.5, §7.5 · ADR: 0004, 0007, 0031 · Code: `packages/records` (`@sm/records`),
`apps/api/src/records`, `packages/ui/src/components/{data-grid,field-*,record-form,highlights-panel,path,related-list}.tsx`,
`apps/web/src/components/records`

RecordService is the only write path for CRM objects (golden rule 2). The API, the worker (mass actions, currency
recalculation, purge) and the seeds all call the same package.

## The write pipeline (§3.7)

1. **Object access:** unknown or unreadable object → 404; no create/edit permission → 403.
2. **Record access** through the sharing predicate: invisible → 404, no edit → 403; changing the owner needs Full
   access.
3. **Input:** unknown and read-only fields → 400; FLS → 403 listing the fields; values through `normaliseValue`.
4. **Defaults:** owner = writer, the default record type, field defaults, default picklist values; for opportunities
   the record type's pipeline and its first open stage.
5. **Stage rules:** probability and forecast category from the stage unless given, `is_closed`/`is_won`, a loss
   reason when lost.
6. **Required fields and references:** lookup targets must exist, be live and readable by the writer; owners are
   active users or queues that take the object.
7. **Currency:** active currencies only; corporate amounts at the dated rate (ADR-0031).
8. **Hooks** (duplicates P03, before-save P08), then **validation rules**.
9. **Optimistic write** on `version` (409 with the current version), stage and field history, derived shares
   (TEAM, IMPLICIT_PARENT, IMPLICIT_CHILD), sharing rules, audit (field names only) and outbox events (record id and
   changed field names, never values).

**Bulk:** `bulkCreate`/`bulkUpdate`/`bulkDelete` take ≤ 200 rows, each in a savepoint with its own result. **Mass
actions** (update, transfer, delete) of up to 10,000 selected records run as worker jobs, as the user who started
them. **Delete** goes to the recycle bin (30 days; an account takes its contacts and opportunities along).

## Reading

Through the [Query Engine](query-engine.md) only. The records API (`/v1/records/{object}[/{id}]`, `/v1/query`,
`…/external/{externalId}` upsert) maps query parameters to SMQ; responses carry `version`; money is `{amount,
currency}`; `If-Match` gives optimistic concurrency; `Idempotency-Key` replays a create for 24 h.

`GET /v1/records/{object}/{id}/page` returns everything a record page needs in one call: the record, the layout
for the viewer's profile × record type (FLS-filtered), the path, related lists and the record's access;
`…/history` is FLS-masked.

## List views

`/v1/objects/{object}/list-views`: system views All, Mine and Recently viewed per object, plus private, group or
everyone views (shared ones need `customize_application`), a pinned default per user, and `…/results` with quick
filters, search, column and sort overrides, keyset paging and a capped count.

## UI

Object homes (`/[section]`) use the DataGrid (virtualised, keyboard J/K/X/E/Enter, inline edit, column chooser,
density, split view, mass actions). Record pages (T2 template) show highlights, path, details, related lists and
history; create and edit use the layout-driven form (quick create in a dialog, full form at `…/new` and
`…/edit`) with unsaved-changes guards and conflict handling.

## Scale

Seeded through `bulkCreate` (`pnpm db:seed --scenario=bank --scale=load`: 500k leads). Budgets are checked by
`pnpm --filter @sm/api perf:records`; numbers in [P02-notes](../phases/P02-notes.md) (T28).

## Tests

`packages/records/test` (pipeline, bulk, delete and purge, mass jobs, derived shares, conversion, currency
recalculation), `apps/api/test/records-api.test.ts`, `record-page.test.ts`, `list-views.test.ts`, the permission
matrix, and `apps/web/e2e/records.spec.ts` (create → edit → convert → search; private sharing, FLS, list views and
inline edit).
