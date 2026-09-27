# P02 — Metadata engine and core CRM: plan

Status: **DRAFT — awaiting owner approval** · Weeks 3–5 · Spec: §3.7, §3.8, §4 (Core CRM, Metadata, Governance), §5,
§6.5, §7.5, §7.17 (mass update/transfer, field history), §7.19, §9.8 (T1, T2), §9.10 (data grid, record components),
§9.15 (Leads, Accounts/Contacts, Opportunities, Setup → Object manager), §10.1, §11.1 · ADRs: 0001, 0004, 0007,
0008, 0020, 0022 · Previous: [P01-handoff.md](P01-handoff.md)

**Exit gate (§14):** create → edit → convert → search flows pass end to end at the 500k-lead seed. The plan adds:
the §11.1 read, write, list and search budgets measured at that seed with sharing on; every §6.5 enforcement point
that exists in P02 has an FLS test; CI green on every job.

## 0. Assumptions pending owner answers

I will proceed on these unless you say otherwise when approving the plan.

| Q      | Assumed answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **13** | **Corporate-currency conversion (blocks this plan).** Opportunity `amount_corporate` uses the rate on the **close date**, and is recomputed when the close date, amount or currency changes. Every other currency field uses the rate on the date its value was **set**. Rates live in a dated `currency_rate` table (admin-maintained in Setup → Currencies & rates; no rate feed in v1). A missing rate falls back to the latest earlier rate, and the record shows which rate date was used.                                                              |
| **11** | **Custom-field indexes.** Custom fields live in the `custom jsonb` column of the standard tables (custom _objects_ are P11). A field an admin marks "indexed" gets a per-tenant partial expression index (`… ((custom->>'fld') …) WHERE tenant_id = …`), built `CONCURRENTLY` by a worker job through a `SECURITY DEFINER` function; standard tables are not partitioned, so this works in PG16. Cap: 10 indexed custom fields per object per tenant until plans (P05) set it. The partitioned `custom_record` case is decided in P11. Recorded as ADR-0030. |
| **12** | **Partitioned tables.** `field_history` (monthly) gets PK `(tenant_id, changed_at, id)`; nothing references it by FK. Same pattern as `audit_log` in P01.                                                                                                                                                                                                                                                                                                                                                                                                    |
| —      | **Session grace window** (P01 decision 1) is **not** in this plan; it waits for your answer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## 1. Scope

**In:**

- **Metadata engine:** `object_definition` / `field_definition` seeded from the `@sm/metadata` catalogue (API names
  unchanged), custom fields on the five core objects (§5.3 types except Roll-Up Summary and Geolocation), picklist
  values per field and per record type, record types, page layouts assigned per profile × record type, compact
  layouts, path settings, validation rules, field-history settings, auto-number sequences. Cached per tenant by
  `metadataVersion` (Valkey + in-process LRU); every change bumps it and writes `setup_audit`.
- **`@sm/formula` v1** (§5.5): Pratt parser, typed AST, type checker with positioned errors, evaluator, the v1
  function list, and a SQL compiler for the filter subset. 300+ cases, fuzz tests, ≥ 90% coverage. Used in P02 by
  validation rules and formula fields (computed on read; formula fields in filters are P11).
- **Core CRM objects:** Lead, Account (hierarchy, cycle-safe), Contact (+ `account_contact_relation`), Opportunity
  (+ contact roles, stage history, forecast category), Campaign (+ members), a minimal Pipeline/Stage model that
  opportunities need (Kanban, gates and the pipeline editor are P04), account and opportunity teams (deferred from
  P01), and implicit parent shares (an opportunity or contact owner can read the parent account).
- **RecordService** (§3.7): create, update, delete, undelete, bulk; object permission, record access and FLS write
  checks; defaults, auto-numbers, validation rules; optimistic concurrency; money + corporate currency; field
  history; audit (with hidden-field masking, the P01 carry-over); outbox events. Before-save automation (P08) and
  duplicate rules (P03) get their extension points now, as no-ops.
- **Query Engine** (§3.8): SMQ AST → Kysely with the sharing predicate, FLS projection, keyset pagination,
  typed filters on standard and `custom` fields, lookups up to 3 levels, record counts ("12,408" / "100k+"),
  statement timeouts. The only read path; aggregates for reports come in P05.
- **Lead conversion** (§4.4) in one RecordService transaction, with field mapping and undo within 24 h.
- **Search v1** (§7.19): weighted `tsvector` + `pg_trgm` + phone-suffix matching, sharing- and FLS-filtered,
  `GET /v1/search`, ⌘K records section, results page with facets, recent items.
- **Recycle bin** (30 days, restore with children, nightly purge), **mass update**, **mass transfer** (and mass
  delete) as jobs through RecordService's bulk path.
- **Public records API** (§10.1): objects, describe, records CRUD, upsert by external id, `POST /v1/query`,
  `If-Match`, `Idempotency-Key`, field-keyed problem+json.
- **UI:** the data grid in `@sm/ui`; T1 object lists (saved views, quick filters, columns, inline edit, bulk
  select and mass actions, split view, keyboard); T2 record pages (Highlights, Path, Overview · Related · History,
  inline edit); quick-create and full create; Convert dialog; account hierarchy view; workspace tabs; Setup →
  Object manager, Currencies & rates, Recycle bin.
- **Seeds:** CRM data for both demo tenants at demo scale (Aurelia: 500k leads, 60k accounts, 90k contacts, 40k
  opportunities, 3 pipelines with record types).
- **P01 carry-overs:** queue-delete guard once queues own records; FLS masking in audit and history payloads;
  owner-leading list indexes; `perf:sharing` rerun on real tables.

**Out (later phases):** activities, the timeline, the Activity tab and activity re-parenting on conversion (P04,
the conversion has the hook); merge and duplicate rules (P03, §7.2); Kanban, stage gates and the pipeline editor
(P04); tags, favourites and follow (P04); custom objects, roll-ups, formula fields in filters, global value sets,
dependent picklists and metadata package export/import (P11); report aggregates (P05); export (P05 with reports).

## 2. Task breakdown

One Conventional Commit per task on the session branch, as in P00/P01; tasks over ~600 lines split into a/b/c.

| #   | Task (commit scope)                             | Contents                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T01 | `feat(db): metadata schema`                     | §4.2 metadata tables (below), seeded from the catalogue at signup and backfilled for existing tenants; `metadata_version` bumped by statement triggers; RLS forced.                                                                                                                                                             |
| T02 | `feat(metadata): metadata service`              | Load and cache per tenant (Valkey + LRU keyed by `metadataVersion`); `describe(object, user)` with FLS applied; field-type registry (validation, storage, formatting per §5.3 type).                                                                                                                                            |
| T03 | `feat(formula): parser and type checker`        | `packages/formula`: tokenizer, Pratt parser, AST with source positions, type checker (Text, Number, Currency, Percent, Boolean, Date, DateTime, Picklist, Null), field and `$User`/`$Org` resolution through metadata, 5-hop cross-object references.                                                                           |
| T04 | `feat(formula): evaluator and SQL compiler`     | Evaluator with the §5.5 v1 functions (Decimal arithmetic, UTC dates, `ISCHANGED`/`PRIORVALUE`/`ISNEW` against the pending write), SQL compiler for the filter subset, 300+ cases, property-based fuzz tests, ≥ 90% coverage gate.                                                                                               |
| T05 | `feat(db): core CRM schema`                     | `lead`, `account`, `contact`, `account_contact_relation`, `opportunity`, `opportunity_contact_role`, `opportunity_stage_history`, `campaign`, `campaign_member`, `pipeline`, `pipeline_stage`, `lead_conversion`; §4.1 columns; generated `search_vector`; owner-leading indexes per sortable field; `record_share` partitions. |
| T06 | `feat(db): record support tables`               | `field_history` (monthly partitions), `recycle_bin_item`, `recent_item`, `currency_rate`, `account_team_member`, `opportunity_team_member`, `custom_field_index` (DDL job state).                                                                                                                                               |
| T07 | `feat(query-engine): SMQ compiler`              | SMQ zod schema; compile to Kysely with sharing predicate, FLS projection, keyset cursor, typed filters (standard columns and `custom`), lookups (3 levels, each through the predicate), counts with a 100k cap, 5 s / 60 s timeouts, EXPLAIN sampling hook. ≥ 90% coverage.                                                     |
| T08 | `feat(records): RecordService writes`           | Create/update pipeline (§3.7 steps 1–8): metadata, object permission, record access, FLS write check (403 listing fields), defaults, auto-numbers, validation rules (422 field-keyed), `version` check (409 with current record), corporate currency, field history, masked audit entry, outbox events.                         |
| T09 | `feat(records): delete, undelete, recycle bin`  | Soft delete with master-detail cascade, restore with children, `recycle_bin_item`, nightly purge after 30 days (worker), queue-delete guard for record-owning queues.                                                                                                                                                           |
| T10 | `feat(records): bulk, mass update and transfer` | Batches of 200 with per-row results; mass update (preview count), mass transfer (open opportunities only, keep teams), mass delete (Modify All); "select all matching" up to 10k runs as a job with progress.                                                                                                                   |
| T11 | `feat(sharing): sharing on CRM tables`          | Ownership changes and rule recalculation on real tables; account/opportunity teams (`TEAM` shares); implicit parent shares; `CONTROLLED_BY_PARENT` for contacts (primary account, Q10) and opportunities; `perf:sharing` against real tables.                                                                                   |
| T12 | `feat(api): records API`                        | `/v1/objects`, `/describe`, records CRUD, external-id upsert, `POST /v1/query`, `If-Match`, `Idempotency-Key`, FLS-stripping serializer, record access 404/403 semantics, cross-tenant suite generated per object.                                                                                                              |
| T13 | `feat(leads): lead conversion`                  | Convert to new or existing account/contact, optional opportunity (name, pipeline and stage from record type), admin field mapping with type checks, lead → `CONVERTED` read-only, `lead_conversion` record, undo within 24 h if untouched.                                                                                      |
| T14 | `feat(search): search v1`                       | Weighted `tsvector` + `pg_trgm` + phone suffix; `GET /v1/search?q=&objects=` post-filtered through the Query Engine (hidden fields neither searched nor highlighted); recent items API.                                                                                                                                         |
| T15 | `feat(metadata): Setup metadata API`            | CRUD for custom fields (API name immutable, type changes limited to safe widenings), picklist values, record types, layouts and assignments, compact layouts, path settings, validation rules (formula checked on save), field-history settings; custom-field index job (Q11).                                                  |
| T16 | `feat(currency): currencies and rates`          | Active currencies per tenant, dated rates API, conversion service used by RecordService (Q13), recalculation job when a rate for a past date changes.                                                                                                                                                                           |
| T17 | `feat(ui): data grid`                           | `@sm/ui` DataGrid (TanStack Table + Virtual): sticky header and first column, resize, reorder, pin, hide, multi-sort, range selection, keyboard grid navigation, cell editors hook, grouped rows, loading/empty/no-results/error/no-permission states, `role="grid"` with indices; stories in every variant × theme × density.  |
| T18 | `feat(ui): record components`                   | Highlights Panel, Path, field renderers and editors per type (currency, number, date/datetime, picklist, lookup chip + hover card, phone, email, URL, checkbox, long text), form layout, related list.                                                                                                                          |
| T19 | `feat(web): object lists (T1)`                  | Lead/Account/Contact/Opportunity/Campaign lists: view picker, saved views (private/groups/all), quick filters, columns, sort, count, load more, inline edit, bulk select + mass actions, split view, `J/K/X/Enter/E`, density.                                                                                                  |
| T20 | `feat(web): record pages (T2)`                  | Highlights, Path (lead status, opportunity stage), Overview (page layout), Related (layout related lists with "New"), History (field history, masked by FLS), inline edit, workspace tabs, recent items.                                                                                                                        |
| T21 | `feat(web): create and edit`                    | Quick-create modal (layout-required fields), full-page create, record-type picker, field-keyed errors, conflict dialog on 409, unsaved-changes guard.                                                                                                                                                                           |
| T22 | `feat(web): convert and account hierarchy`      | Convert dialog (match existing account/contact, optional opportunity, undo toast), account hierarchy tree view.                                                                                                                                                                                                                 |
| T23 | `feat(web): global search`                      | ⌘K Records section (top 5 per object, grouped, typo-tolerant), search results page with facets (object, owner, date).                                                                                                                                                                                                           |
| T24 | `feat(web): object manager — fields`            | Setup → Object manager: objects, fields list, new custom field wizard (type → details → FLS → layouts), picklist values, record types.                                                                                                                                                                                          |
| T25 | `feat(web): object manager — layouts and rules` | Page layout editor (sections, columns, drag with a keyboard alternative), compact layouts, path settings, validation rules with a formula editor (inline type errors), field-history settings.                                                                                                                                  |
| T26 | `feat(web): currencies and recycle bin`         | Setup → Currencies & rates; Recycle bin (own items; all items for admins) with restore.                                                                                                                                                                                                                                         |
| T27 | `feat(seed): CRM demo data`                     | Pixelcraft (2k leads, 400 accounts, 900 contacts, 150 opportunities, 1 pipeline) and Aurelia (500k leads, 60k accounts, 90k contacts, 40k opportunities, 3 bank pipelines, record types) through RecordService's bulk path; deterministic.                                                                                      |
| T28 | `perf(records): scale check at 500k`            | Measure §11.1 read, write, list (50 rows, sharing on, indexed filter), search and conversion at the Aurelia seed; tune indexes; record numbers.                                                                                                                                                                                 |
| T29 | `test(e2e): P02 journeys`                       | Create → edit → convert → search; list views and inline edit; FLS-hidden field absent everywhere; record-access 404; light + dark with axe; a scale workflow (manual + nightly) that seeds 500k and runs the journey.                                                                                                           |
| T30 | `docs: P02 docs + handoff`                      | ERD, `docs/modules/{metadata,formula,query-engine,records,search,leads}.md`, ADR-0030 (custom-field indexes) and ADR-0031 (currency conversion), P02-handoff.md, ROADMAP.                                                                                                                                                       |

**Sequence:** T01 → T02 → (T03 → T04) ∥ (T05 → T06) → T07 → T08 → (T09, T10, T11, T16) → T12 → (T13, T14, T15) →
T17 → T18 → T19 → T20 → T21 → T22 → T23 → T24 → T25 → T26 → T27 → T28 → T29 → T30.

## 3. Design notes

### 3.1 Metadata

Standard objects keep their typed columns (§5.1). Their `field_definition` rows point at those columns; custom
fields point at a key in `custom jsonb`. Picklist values are stored per field with a stable API value and a label
key or label, so admins rename labels without touching data. Lead status values also map to the §4.3 system
categories. An API name never changes once created. A field type change is allowed only when it widens safely
(Text → Long Text, Number precision up); anything else is "create a new field and migrate".

### 3.2 Query Engine

SMQ is validated by zod, then every field reference is resolved through metadata **as the caller**: a field the
caller cannot read is rejected in filters and sort (400, not silently dropped) and stripped from the projection.
Lookups compile to `LEFT JOIN`s whose joined row passes its own sharing predicate, otherwise the lookup shows as
"no access" rather than leaking the name. Keyset pagination orders by the sort keys plus `id`. Counts run as a
capped `count(*) … LIMIT 100001`.

### 3.3 RecordService

One pipeline for every write, in the caller's tenant transaction, in the §3.7 order. The same code serves the API,
the UI, conversion, mass actions, seeds and (later) imports and automation. Outbox events carry changed field names,
never values of hidden fields. Field history stores old/new values for tracked fields; the History tab and the audit
viewer mask fields the viewer cannot read (§6.5).

### 3.4 Money

`numeric(18,2)` + `currency_code` per record (§0.4 rule 8); `amount_corporate` per Q13, with the rate date stored
on the record (`corporate_rate_date`). All arithmetic in `Decimal`; the API sends money as string decimals.

### 3.5 Search

`search_vector` is a generated column (A: name, email, phone; B: company or account; C: other text fields marked
searchable). Phone numbers are stored as E.164 plus a reversed-digits column for suffix matching. Queries rank with
`ts_rank`, fall back to `pg_trgm` similarity for typos, and are post-filtered through the Query Engine so sharing
and FLS apply. The `SearchProvider` interface keeps the OpenSearch adapter (P12) a drop-in.

### 3.6 Scale

The T22 carry-over is built in from the start: every sortable standard field gets a `(tenant_id, owner_id, field,
id)` index as well as `(tenant_id, field, id)`, so a rep's "my leads by name" and an admin's "all leads by name" both
walk an index. T28 checks the plans with `EXPLAIN (ANALYZE, BUFFERS)` at 500k and records them.

## 4. Data model diff (all tenant tables: `tenant_id` leads every key, RLS forced, UUIDv7)

- **Metadata:** `object_definition`, `field_definition`, `picklist_value`, `record_type`, `record_type_picklist`,
  `page_layout`, `layout_assignment`, `compact_layout`, `path_setting`, `validation_rule`, `field_history_setting`,
  `auto_number_sequence`, `list_view`, `custom_field_index`.
- **Core CRM:** `lead`, `account`, `contact`, `account_contact_relation`, `opportunity`, `opportunity_contact_role`,
  `opportunity_stage_history`, `campaign`, `campaign_member`, `pipeline`, `pipeline_stage`, `lead_conversion`,
  `account_team_member`, `opportunity_team_member`. Each object table: §4.1 standard columns, `custom jsonb`,
  `search_vector`, `external_id` unique per tenant, owner-leading indexes.
- **Governance and support:** `field_history` (monthly partitions), `recycle_bin_item`, `recent_item`,
  `currency_rate`, `tenant_currency`.
- **Changed:** `record_share` gains its per-object partitions for the new tables; `tenant_settings.metadata_version`
  starts moving.

## 5. API diff (zod contract + OpenAPI + ≥ 4 integration tests each, including cross-tenant 404)

- **Records:** `GET /v1/objects` · `GET /v1/objects/{object}/describe` · `GET|POST /v1/records/{object}` ·
  `GET|PATCH|DELETE /v1/records/{object}/{id}` · `PUT /v1/records/{object}/external/{externalId}` ·
  `POST /v1/records/{object}/{id}/undelete` · `POST /v1/query` · `GET /v1/search`.
- **Actions:** `POST /v1/leads/{id}/convert` · `POST /v1/leads/{id}/convert/undo` ·
  `POST /v1/records/{object}/mass-update|mass-transfer|mass-delete` (jobs) · `GET /v1/jobs/{id}`.
- **Metadata (Setup):** `GET|POST /v1/metadata/{type}` and `GET|PATCH|DELETE /v1/metadata/{type}/{id}` for fields,
  picklist values, record types, layouts, layout assignments, compact layouts, path settings, validation rules,
  field-history settings; `POST /v1/metadata/validation-rules/check` (formula check without saving).
- **Other:** `GET|POST /v1/list-views`, `PATCH|DELETE /v1/list-views/{id}` · `GET|PUT /v1/currencies`,
  `GET|POST /v1/currency-rates` · `GET /v1/recycle-bin`, `POST /v1/recycle-bin/purge` (admin) ·
  `GET /v1/recent-items` · `GET|POST|DELETE /v1/records/{object}/{id}/team`.

## 6. Test plan

- **Unit:** formula (300+ cases, fuzz, ≥ 90%), query-engine SMQ compiler (≥ 90%), field-type registry, money and
  currency conversion, conversion mapping.
- **Integration:** every endpoint ≥ 4 tests (happy path, validation, permission denial, cross-tenant 404), plus FLS
  stripping and optimistic lock where relevant. A generated suite per standard object covers read, update, delete,
  list, search and query across tenants.
- **FLS matrix:** one hidden field checked at every §6.5 point that exists in P02: Query Engine projection, API
  serializer, RecordService writes, search (not searchable, not highlighted), list-view columns, history and audit
  viewers.
- **Sharing:** the P01 matrix re-run against real object tables, plus teams and implicit parent shares.
- **E2E + axe:** T29 journeys in light and dark; visual baselines for T1 and T2.
- **Performance:** T28 at the 500k seed, with results in the handoff.

## 7. Risks

1. **Scope.** This is the largest phase so far. If it runs long, I will cut in this order and say so at a
   mid-phase report: layout drag-and-drop (keep the keyboard editor), split view, account hierarchy view.
2. **500k seed time in CI.** Seeding through RecordService at ~2,000 rows/s takes ~5 minutes; the scale journey
   runs as a separate manual and nightly workflow, not on every push.
3. **Query plans at scale.** Sharing predicate + keyset + filters can pick bad plans; T28 fixes indexes with
   evidence. A 5M-lead run is for P05/P12 (Q6).
4. **Formula engine correctness.** Mitigated by 300+ cases, fuzzing, and the SQL compiler checked against the
   evaluator on the same inputs.
5. **Metadata cache staleness.** Every change bumps `metadataVersion` in the same transaction as the change (the
   `permVersion` pattern from P01).

## 8. Definition of Done for P02

Every task meets §13.4. The exit gate is evidenced: the T29 journey green at the 500k seed; §11.1 budgets measured
(T28); the FLS matrix green; `db:rls-audit` green with every new table; coverage gates passing (`formula`,
`query-engine` ≥ 90%); P02-handoff.md written.
