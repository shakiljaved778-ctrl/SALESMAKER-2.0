# P02 handoff: metadata engine and core CRM

Plan: [P02-plan.md](P02-plan.md) · Tasks: [P02-tasks.md](P02-tasks.md) (30/30) · Decisions, deviations and
follow-ups: [P02-notes.md](P02-notes.md) · Branch: `claude/great-heisenberg-pbhzs3` (one Conventional Commit per task,
plus fixes found on the way)

## Exit gate

| Gate                                                                    | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create → edit → convert → search end to end at the 500k-lead seed (§14) | `apps/web/e2e/records.spec.ts` (create → edit → convert → search; sharing, FLS, list views, inline edit) and `scale.spec.ts` (an agent at 500k leads: list, open, search) green together locally against the bank seed at load scale (500k leads, 60k accounts, 90k contacts, 40k opportunities). The records journeys run in CI on every push; the scale journey runs in the nightly/manual `scale` workflow.                                                                                                                                                                                                         |
| §11.1 budgets measured at that seed, sharing on (T28)                   | `pnpm --filter @sm/api perf:records`: read p95 25 ms (budget 120), write 41 ms (250), list first page with count 145 ms worst (400), worst list p95 228 ms, search 187 ms worst (200), list to rendered rows 502 ms median (800). Table and the plans behind three fixes in [P02-notes](P02-notes.md#t28--scale-check-at-500k). Typo-only search is over budget: Q31.                                                                                                                                                                                                                                                  |
| Every §6.5 enforcement point that exists in P02 has an FLS test         | Query Engine projection, filters and sorts (`packages/query-engine/test/smq.test.ts`); API serializer and writes (`apps/api/test/records-api.test.ts`, permission matrix FLS rows); RecordService writes (`packages/records/test/service.test.ts`); search, neither matched nor highlighted (`packages/query-engine/test/search.test.ts`); list-view columns, sorts and filters (`apps/api/test/list-views.test.ts`); history viewer masking (`apps/api/test/record-page.test.ts`); and end to end in the sharing/FLS journey. Reports, exports, Kanban, merge fields, AI context and webhooks arrive in later phases. |
| `db:rls-audit` green with every new table                               | CI `db` job on every push (migrations 0015–0021).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Coverage gates                                                          | `@sm/formula` 99.1% lines, `@sm/query-engine` 98.5%, `@sm/permissions` 100%; every other package ≥ 82% (api 94.4%, records 96.4%, db 93.6%, web 94.9%, ui 89.9%).                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| CI green on every job                                                   | Latest runs green: lint · typecheck · unit, db, both e2e shards, Storybook axe, gitleaks, Terraform.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## What was built

- **Metadata engine.** Object, field, picklist, record type, layout, compact layout, path, validation rule,
  auto-number and list view metadata, synced from a standard catalogue (insert-only, so admin edits survive), cached
  in process and Valkey by `metadataVersion`. 15 custom field types in `custom jsonb`; safe type widenings only.
  See [metadata](../modules/metadata.md).
- **`@sm/formula`.** Parser, type checker (43 functions, cross-object paths), Decimal evaluator and a SQL compiler
  proven equal to the evaluator on Postgres. See [formula](../modules/formula.md).
- **Query Engine.** SMQ → one Kysely statement with the sharing predicate, FLS projection, lookups, keyset paging and
  capped counts. See [query engine](../modules/query-engine.md).
- **RecordService (`@sm/records`).** The §3.7 pipeline for every write, bulk and mass actions (as worker jobs),
  recycle bin with cascades and purge, derived TEAM and IMPLICIT shares, lead conversion with undo, dated-rate
  currency conversion with recalculation jobs. See [records](../modules/records.md), [leads](../modules/leads.md),
  ADR-0031.
- **Core CRM.** Lead, account, contact, opportunity, campaign with pipelines and stages, contact roles, relations,
  stage and field history, team members.
- **Search v1.** Weighted full text, trigram typo fallback, phone suffixes, sharing and FLS applied twice; recent
  items. See [search](../modules/search.md).
- **APIs.** Records CRUD, upsert by external id, SMQ, mass actions and jobs, teams, recycle bin, list views, record
  page, lead conversion and field mapping, search, currencies and rates, and Setup for fields, record types, layouts,
  compact layouts, paths, validation rules (with a live formula check) and field history.
- **UI.** `@sm/ui` DataGrid (virtualised, keyboard grid, inline edit) and record components (field renderers and
  editors, Highlights panel, Path, record form, related lists). Object lists (T1), record pages (T2), quick and full
  create/edit, convert dialog, account hierarchy, global search and ⌘K records, recycle bin, workspace tabs; Setup's
  Object manager (fields wizard, layout editor, compact layouts, paths, validation rules, field history) and
  Currencies & rates. Every screen axe-clean in light and dark.
- **Demo data.** `pnpm db:seed --scenario=agency|bank --scale=demo|load` now fills the CRM deterministically and
  resumably through RecordService; the bank load scale is the 500k test bed.
- **Docs.** [ERD](../spec/ERD.md) (metadata, core CRM, record support), six module docs, ADR-0030 (custom-field
  indexes) and ADR-0031 (currency conversion).

## Tests

1,889 unit and integration tests (api 589, formula 542, ui 212, db 103, query-engine 87, web 77, records 51, worker
39, permissions 32, metadata 29, server-kit 29, config 22, control-api 21, testing 17, contracts 11, integrations 11,
i18n 7, ai 6, emails 4), Storybook axe on every story, and 13 end-to-end tests (3 new in P02: two journeys and the
scale journey). Every new endpoint has happy-path, validation, permission and cross-tenant (404) tests.

## Found and fixed late in the phase

- **Lists scanned every row (T28).** The sharing predicate's `OR (subquery) OR EXISTS` shape could not use an index,
  and the planner could not size the visibility closure; JIT compiled OLTP statements. Lists now use a BitmapOr over
  the owner index and the primary key with the closure inlined per request, and JIT is off: an agent's list count
  went from 622 ms to 4–8 ms, a status-filtered list from 513 ms to 18 ms.
- **Search scored every row (T28).** Typo matching was OR-ed into every search; it is now a "did you mean" fallback.
  Exact search went from 1.4–4.6 s to ≤ 187 ms p95.
- **Typing lost in a new-record form (T29).** The form loaded its layout twice and wiped what had been typed in
  between; caught by the journey under CI load.
- **Seeding at load scale (T27/T28).** Batch transaction time, deadlocks between batches on shared accounts (retry,
  children one batch at a time), and Docker's 64 MB `/dev/shm` for Postgres (now 512 MB).

## Decisions for the owner

1. **Refresh-token grace window (P01 decision 1), now with evidence.** Under load, leaving a page while it performs
   its one session refresh signed users out in the e2e journeys. The proposal is unchanged: accept the immediately
   previous token for ~30 s after rotation and return the same successor, still revoking the family on any other
   reuse. It changes the session security design, so it waits for you.
2. **Q31: search indexes under row-level security.** Full-text and trigram GIN indexes cannot drive a scan for
   `sm_app` because their operators are not leakproof. Exact search meets the budget at 500k but grows linearly;
   typo-only searches take ~1.2 s for an administrator. Proposal: a narrowly scoped `SECURITY DEFINER` function, owned
   by a `BYPASSRLS` role, that returns candidate ids for one tenant, with sharing and display still run as the user
   (a tenancy-design change). Alternatives in `OPEN_QUESTIONS.md`.
3. **Q30: how custom-field indexes are built** (ADR-0030). Indexed custom fields are recorded as PENDING until you
   choose.
4. **Two sharing calls from T11, kept as built until you say otherwise:** manual shares survive an owner change
   (Salesforce removes them); under Controlled by Parent a contact's own owner gets no access beyond the account's.
5. **Open questions** still pending: Q1, Q6, Q9, Q14, Q16–Q19, Q21–Q31 in `docs/spec/OPEN_QUESTIONS.md`.

## Carried into P03

- **Imports and concurrent bulk writes (P03 import wizard):** many contacts under the same accounts deadlock on implicit shares
  across transactions; the import job must retry (as the seed does) or the share sync must lock parents in id order.
- **Saved filters on hidden fields:** a shared view whose saved filter uses a field the viewer cannot read fails for
  that viewer (400) instead of running without it; decide whether to drop such conditions (columns and sorts are
  already dropped).
- **Lead record types and conversion mapping:** conversion has no lead-record-type → opportunity-record-type
  mapping yet.
- **pg 9:** Prisma's engine issues overlapping queries inside interactive transactions (deprecation warning in pg 8).
- **Indexed custom fields, unique and external-id custom fields:** wait on Q30.
- **Corporate amounts in the API, UI and reports:** stored and recalculated, not exposed yet; reports (P05) need
  them.
- **Scale workflow:** first nightly run on a GitHub runner pending; local numbers are from a 4-vCPU container.

## For P03

Re-read CLAUDE.md, §7.1–§7.4 (lead capture, duplicates, assignment, queues and SLAs, scoring), §4.3 (lead
lifecycle), ADR-0007 and ADR-0014 (public API), this handoff and P02-notes.md, then write `P03-plan.md` and stop for
approval.
