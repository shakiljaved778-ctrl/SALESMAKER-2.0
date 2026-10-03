# P03 — Lead capture, routing and data quality: plan

Status: **DRAFT, awaiting approval** · Weeks 5–6 · Spec: §4.3, §6.5, §7.1–§7.4, §9.15 (Leads: import wizard, queue
pick-up, duplicate review, merge; Setup: matching & duplicate rules, assignment rules, SLA policies, scoring models,
business hours, web forms, email-to-lead, API keys, data import history), §10.1, §11.1 (import throughput) · ADRs:
0001, 0004, 0007, 0008, 0014, 0022 · Previous: [P02-handoff.md](P02-handoff.md)

**Exit gate (§14):** import 100k rows with dedupe + routing in < 60 s on staging. The plan adds: ≥ 2,000 rows/s per
import job (§11.1) with dedupe and assignment on, against the 500k-lead bank seed; every capture path (import, web
form, email-to-lead, REST API) sets source fields and runs duplicate and assignment rules; every new endpoint with
its four integration tests including cross-tenant 404; CI green on every job.

## 0. Assumptions pending owner answers

I will proceed on these unless you say otherwise when approving the plan.

| Q                                                        | Assumed answer                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Staging**                                              | Staging is not deployed yet (P00 left a Terraform stub). The exit gate is measured on the nightly `scale` workflow's GitHub runner and locally, both with the 500k seed loaded; the staging run happens when staging exists.                                                                                                                                                                                                                          |
| **Activities are P04**                                   | SLA "first touch" means, until P04, the first change of the lead's status out of the `OPEN` category or an explicit `POST …/touch` from an integration; P04 adds calls, emails and WhatsApp as touches. The engagement score counts form submissions and inbound emails now, activities from P04 and replies from P06.                                                                                                                                |
| **Email-to-lead, known sender**                          | Until activities exist, an email from a known lead or contact is stored as an inbound email on that record (shown on its page) instead of creating a lead; P04 turns these into activities.                                                                                                                                                                                                                                                           |
| **Fuzzy matching without Q31**                           | Matching rules find candidates through indexed match keys (normalised email, E.164 phone, Double Metaphone of the last name, normalised company without legal suffixes), maintained by trigger, then score candidates with `pg_trgm` similarity. Equality on keys uses btree indexes, which work under row-level security, so duplicate checks stay fast whatever the answer to Q31. Adds the `fuzzystrmatch` contrib extension (PostgreSQL licence). |
| **Disposable-email list**                                | Web forms reject disposable domains from a bundled list. The maintained public list (`disposable-email-domains`) is CC0 (public domain), which is outside MIT/Apache/BSD/ISC, so it needs your OK; otherwise I ship a short hand-made list and a Setup field for extra domains.                                                                                                                                                                       |
| **Libraries**                                            | `csv-parse` (MIT) and `exceljs` (MIT) for imports, `mailparser` (MIT) for email-to-lead. Cloudflare Turnstile sits behind an adapter with a fake; it stays off until you provide keys (free service, spec-named).                                                                                                                                                                                                                                     |
| **Notifications**                                        | SLA escalations and assignments need somewhere to land: a minimal in-app notification store and the header bell's list arrive now (`notification`); preferences, email and push stay with §7.18 (P04).                                                                                                                                                                                                                                                |
| **Saved view filters on hidden fields (P02 carry-over)** | A shared view's saved filter condition on a field the viewer cannot read is dropped for that viewer, like its columns and sorts, instead of failing the view.                                                                                                                                                                                                                                                                                         |
| —                                                        | **Session grace window** (P01 decision 1), **Q30** and **Q31** are not in this plan; they wait for your answers.                                                                                                                                                                                                                                                                                                                                      |

## 1. Scope

**In:**

- **REST API + API keys** (§10.1, §6 identity): keys prefixed `sm_live_` / `sm_test_`, stored hashed, scoped to a
  run-as integration user, with expiry, last-used tracking, rotation and revocation; per-key rate limits with the
  standard headers; the records, query, search and conversion routes published in OpenAPI for API keys.
- **A set-based bulk write path in RecordService** that keeps the §3.7 pipeline (access, FLS, types, defaults,
  validation rules, references, currency, history, sharing, audit, outbox) but works on a batch at a time: one
  multi-row insert, prefetched references, set-based derived shares and sharing rules, batched audit and outbox. It
  is what import, forms and email-to-lead write through, and what reaches 2,000 rows/s.
- **Duplicate management** (§7.2): matching rules (exact, fuzzy, phone, email domain + name, company
  normalisation), duplicate rules (Block or Alert, bypass for chosen profiles) on create and edit through
  RecordService, potential-duplicates panel, merge of 2–3 records (field winners, children re-parented,
  `merged_into_id`, history), scheduled duplicate jobs feeding a review queue.
- **Lead capture** (§7.1): CSV/XLSX import wizard (sheet pick, header detection, mapping with suggestions and saved
  templates, transforms, duplicate handling, 100-row dry run, async run with progress, results file, undo within
  72 h, optional assignment); web-to-lead forms (builder, hosted page, JS embed and iframe, honeypot, per-IP rate
  limit, disposable-email check, optional Turnstile, UTM/referrer/landing page/click ids, campaign attribution,
  per-form assignment rule and auto-responder); email-to-lead (per-tenant inbound addresses, MIME parsing, raw
  email kept). Every path sets `lead_source`, `lead_source_detail`, `campaign_id` and `captured_via`.
- **Routing** (§7.3, no territories): assignment rules with ordered entries, criteria (filter tree or formula) and
  methods `ROUND_ROBIN`, `WEIGHTED`, `LOAD_BALANCED`, `SKILLS_BASED`, `STICKY_ACCOUNT`, `QUEUE`, `SPECIFIC_USER`;
  capacity (max open, max new per day) and availability (working hours in the user's time zone, out of office);
  `assignment_log` and "Why was this assigned to me?"; queue pick-up with Accept and Take next (`SKIP LOCKED`);
  business hours and holidays; SLA policies (first touch, time to qualify) with an escalation ladder and optional
  auto-reassign; lead recycling.
- **Rules-based scoring** (§7.4): scoring models with fit rules (formula criteria, points) and engagement rules
  (events with time decay), grade A–D, combined score as lead fields (filterable, sortable), `score_history`,
  recalculation on events and nightly.
- **UI:** import wizard (T6), duplicate review (T7) and merge modal, queue pick-up (T1), potential duplicates and
  "Why assigned" on record pages, SLA chips on records and lists, score and grade columns; Setup → API keys,
  Matching & duplicate rules, Assignment rules, Business hours, SLA policies, Scoring models, Web forms,
  Email-to-lead, Data import history; the header bell.
- **P02 carry-overs:** retry on deadlock in import batches; hidden-field conditions in saved view filters.

**Out (later phases):** territories (P10); WhatsApp inbound and lead ads (P06); AI signature parsing and predictive
scoring (P07); activities and touches from calls and emails (P04); notification preferences, email and push (P04);
outbound webhooks (P08); bulk API, OAuth apps and SDK (P12); agent state availability (P06).

## 2. Task breakdown

Each task is one Conventional Commit on the session branch, pushed with CI green.

| #   | Commit                                              | Content                                                                                                                                                                                                                                                                                                                                                                   |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T01 | `feat(db): capture and data-quality schema`         | Migration 0022: `api_key`, `import_job`, `import_mapping_template`, `web_form`, `web_form_field`, `web_form_submission`, `inbound_email_address`, `inbound_email`, `matching_rule`, `duplicate_rule`, `duplicate_job`, `duplicate_candidate`; `merged_into_id` on lead, account, contact; match-key columns and triggers (`fuzzystrmatch`); RLS and audit on every table. |
| T02 | `feat(db): routing, SLA and scoring schema`         | Migration 0023: `assignment_rule`, `assignment_rule_entry`, `assignment_pool_member`, `round_robin_cursor`, `user_capacity`, `user_availability`, `user_skill`, `assignment_log`, `business_hours`, `holiday`, `sla_policy`, `sla_timer`, `recycle_rule`, `scoring_model`, `scoring_rule`, `score_history`, `notification`.                                               |
| T03 | `feat(metadata): capture and score fields`          | Catalogue v3: lead `lead_source_detail`, `captured_via`, UTM fields, `referrer`, `landing_page`, `gclid`, `fbclid`, `fit_score`, `engagement_score`, `score`, `grade`; synced to existing tenants. P02 carry-over: hidden-field conditions in saved view filters are dropped for that viewer.                                                                             |
| T04 | `feat(api): API keys`                               | Create (secret shown once), list, rotate, revoke, expiry, last used; auth guard for `Bearer sm_live_…`; per-key token bucket and headers; records, query, search and convert routes public in OpenAPI; setup audit.                                                                                                                                                       |
| T05 | `feat(records): set-based bulk inserts`             | `bulkInsert` through the §3.7 pipeline on a batch: TS validation with prefetched references and validation-rule inputs, one multi-row insert, set-based derived shares and sharing rules, batched history, audit and outbox; per-row results; equivalence tests against the single-row path.                                                                              |
| T06 | `feat(dedupe): matching and duplicate rules`        | Rule engine: candidates by match keys, similarity scoring, within-batch duplicates; duplicate rules (Block, Alert, bypass profiles) in RecordService's duplicates hook for single and bulk writes.                                                                                                                                                                        |
| T07 | `feat(api): duplicates`                             | `POST /v1/records/{object}/duplicates/check`, potential duplicates of a record, Setup CRUD for matching and duplicate rules (with test-a-record preview).                                                                                                                                                                                                                 |
| T08 | `feat(records): merge`                              | `POST /v1/records/{object}/merge`: 2–3 records, field winners, children re-parented (contacts, opportunities, contact roles, relations, campaign members, team members), losers to the recycle bin with `merged_into_id`, merge in history and audit.                                                                                                                     |
| T09 | `feat(dedupe): duplicate jobs`                      | Scheduled and on-demand tenant scans per rule (keyset batches), `duplicate_candidate` review queue with dismiss and merge; API.                                                                                                                                                                                                                                           |
| T10 | `feat(routing): assignment engine`                  | Ordered entries, criteria (filter tree or formula), the seven methods, pools, cursors locked per batch, capacity and availability, queues as owners, `assignment_log` with candidates and reason; runs on create from any capture path and on `POST /v1/assignment/run`.                                                                                                  |
| T11 | `feat(routing): business hours and availability`    | Business hours and holidays (Setup API), user working hours, out of office and skills; business-time arithmetic library used by SLA.                                                                                                                                                                                                                                      |
| T12 | `feat(routing): queue pick-up`                      | Queue views, `POST …/accept` and `POST /v1/queues/{id}/take-next` (`FOR UPDATE SKIP LOCKED`), audit.                                                                                                                                                                                                                                                                      |
| T13 | `feat(sla): SLA policies and timers`                | Policies (first touch, time to qualify; business-hours aware), timers started at assignment, worker ladder (50% owner, 100% manager, optional auto-reassign via a rule), breaches; `POST …/touch`; SLA status in record and list queries.                                                                                                                                 |
| T14 | `feat(notifications): in-app notifications`         | `notification` writes for assignment and SLA events, `GET /v1/notifications`, mark read, unread count; realtime invalidation event.                                                                                                                                                                                                                                       |
| T15 | `feat(routing): lead recycling`                     | Recycle rules (criteria, days) on a daily job: Unqualified/Nurture leads back to New and re-routed, logged.                                                                                                                                                                                                                                                               |
| T16 | `feat(scoring): rules-based scoring`                | Models with fit rules (formula criteria, points, capped 0–100), engagement rules (event points, half-life decay), grade bands, combined score; recalculation on writes and events and nightly; `score_history`; Setup API.                                                                                                                                                |
| T17 | `feat(import): import engine`                       | Worker job: streaming CSV/XLSX parse, mapping and transforms (picklist map, date formats, phone country, owner by email or name, currency), duplicate handling (skip, update, create anyway), dry run on 100 rows, batches through `bulkInsert`, progress, results file, undo within 72 h, optional assignment; deadlock retry.                                           |
| T18 | `feat(api): imports`                                | Upload (StorageProvider), sheets and headers, mapping suggestions (labels, synonyms, previous mappings) and templates, dry run, start, progress, results download, undo, history.                                                                                                                                                                                         |
| T19 | `feat(forms): web-to-lead`                          | Form definitions (fields from lead metadata, hidden fields, defaults, picklist subsets, consent text), public submission endpoint per cell (honeypot, per-IP limit, disposable domains, Turnstile adapter + fake), UTM and click ids, campaign attribution, per-form assignment rule, auto-responder through EmailSender (Mailpit locally).                               |
| T20 | `feat(web): hosted forms and embed`                 | Hosted page (`/f/{tenant}/{form}` locally, `forms.salesmaker.app` in cells), JS snippet and iframe, design tokens light/dark/auto, thank-you or redirect, axe.                                                                                                                                                                                                            |
| T21 | `feat(email): email-to-lead`                        | Per-tenant inbound addresses, inbound adapter (SES in cells, fake locally), MIME parsing, raw email stored, lead created through the capture pipeline or stored on the known record.                                                                                                                                                                                      |
| T22 | `feat(web): import wizard (T6)`                     | Upload → sheet → headers → mapping → transforms → duplicates → dry run → run with progress → results; import history with undo.                                                                                                                                                                                                                                           |
| T23 | `feat(web): duplicates`                             | Potential-duplicates panel on record pages, Block errors in forms, duplicate review (T7), merge modal (field-by-field winners); Setup → Matching & duplicate rules.                                                                                                                                                                                                       |
| T24 | `feat(web): assignment`                             | Setup → Assignment rules (entries, criteria, methods, pools, capacity), Business hours, users' availability and skills; "Why was this assigned to me?" on records.                                                                                                                                                                                                        |
| T25 | `feat(web): queues and SLA`                         | Queue pick-up (T1) with Accept and Take next; Setup → SLA policies; SLA chips on records and lists; breaches list; the header bell.                                                                                                                                                                                                                                       |
| T26 | `feat(web): scoring`                                | Setup → Scoring models (rules with the formula editor, decay, grade bands); score and grade on records and lists.                                                                                                                                                                                                                                                         |
| T27 | `feat(web): forms, email-to-lead and API keys`      | Setup → Web forms (builder with live preview, embed codes), Email-to-lead (addresses, defaults), API keys (create, rotate, revoke).                                                                                                                                                                                                                                       |
| T28 | `feat(seed): capture demo data`                     | Demo rules, queues, SLA policies, scoring models, forms and an import template for both tenants; a 100k-row import file generator for the gate.                                                                                                                                                                                                                           |
| T29 | `perf(import): 100k import with dedupe and routing` | The exit-gate measurement at the 500k seed (import, dedupe against existing leads and within the file, round robin with capacity); tune until < 60 s; numbers in the handoff; added to the `scale` workflow.                                                                                                                                                              |
| T30 | `test(e2e): P03 journeys`                           | Import with duplicates and routing; a form submission routed into a queue, taken next and touched before the SLA; merge from the review queue; API key used from outside; axe light and dark.                                                                                                                                                                             |
| T31 | `docs: P03 docs and handoff`                        | ERD, module docs (capture, dedupe, routing, SLA, scoring, API keys), ADR for the set-based bulk path and match keys, P03-handoff.md, ROADMAP.                                                                                                                                                                                                                             |

**Sequence:** T01 → T02 → T03 → T04 → T05 → (T06 → T07 → T08 → T09) ∥ (T11 → T10 → T12 → T13 → T14 → T15) →
T16 → T17 → T18 → T19 → T20 → T21 → T22 → T23 → T24 → T25 → T26 → T27 → T28 → T29 → T30 → T31.

## 3. Design notes

### 3.1 The bulk path

T28 of P02 measured RecordService at ~180 rows/s with four concurrent batches: about ten statements and several
Prisma round trips per row. Imports need ≥ 2,000 rows/s per job, so the bulk path does per-batch what the
single-row path does per row, without bypassing it (golden rule 2):

- **Validate in memory:** types (`normaliseValue`), required fields, picklists, FLS and validation rules (the
  formula evaluator, with related-record values prefetched once per batch).
- **References in one query per lookup field;** owners checked against active users and queues once per batch.
- **One multi-row `INSERT … RETURNING`;** auto-numbers drawn as a block from the per-field sequence.
- **Set-based after-insert work:** derived shares and owner/criteria sharing rules computed in SQL over the
  inserted ids, history and outbox written with one insert each, audit through the existing sequence-then-chain
  batcher (one row per record).
- **Per-row results** keep the savepoint semantics: rows that fail validation are reported and skipped before the
  insert; a database error splits the batch and retries halves to isolate the bad row.

A property test runs random inputs through both paths and compares records, shares, history and audit.

### 3.2 Duplicates

Match keys are columns maintained by trigger (`match_email`, `match_phone`, `match_name_key`, `match_company_key`)
with `(tenant_id, key)` btree indexes. A rule's comparisons decide which keys select candidates; candidates are then
scored (exact, `similarity()` against a threshold, domain + name), all as the writer (sharing applies, so a user is
only warned about duplicates they can see; Block applies regardless of visibility and says so without details).
Within an import file, rows are de-duplicated against each other in memory with the same keys.

### 3.3 Assignment

Rules are evaluated in order; the first entry whose criteria match decides the method. Round robin and weighted
cursors live in `round_robin_cursor`, locked once per batch, so concurrent imports and forms never hand the same
slot twice. Capacity counts open records by status category and today's new records. Every decision writes
`assignment_log` with the candidates considered and why each was skipped, which the record page shows.

### 3.4 SLA

Timers start at assignment and store their due instants in UTC, computed with business-time arithmetic over the
policy's calendar (business hours, holidays, the owner's time zone when the policy says so). A worker scans due
thresholds every minute and acts once per threshold (idempotent by timer and step).

### 3.5 Capture surfaces

Forms and email-to-lead are unauthenticated entry points into a tenant: the form id resolves to its tenant through
the control plane, submissions run as the form's run-as user (an integration user with lead create only), and every
submission is stored before processing so nothing is lost when a rule rejects it.

## 4. Data model diff (all tenant tables: `tenant_id` leads every key, RLS forced, UUIDv7)

- **Capture:** `api_key`, `import_job`, `import_mapping_template`, `web_form`, `web_form_field`,
  `web_form_submission`, `inbound_email_address`, `inbound_email`.
- **Data quality:** `matching_rule`, `duplicate_rule`, `duplicate_job`, `duplicate_candidate`; `merged_into_id` and
  match-key columns on lead, account, contact.
- **Routing and SLA:** `assignment_rule`, `assignment_rule_entry`, `assignment_pool_member`, `round_robin_cursor`,
  `user_capacity`, `user_availability`, `user_skill`, `assignment_log` (monthly partitions), `business_hours`,
  `holiday`, `sla_policy`, `sla_timer`, `recycle_rule`.
- **Scoring:** `scoring_model`, `scoring_rule`, `score_history` (monthly partitions); score fields on lead.
- **Notifications:** `notification`.

Every migration is additive (expand only).

## 5. API diff (zod contract + OpenAPI + ≥ 4 integration tests each, including cross-tenant 404)

- **API keys:** `GET|POST /v1/setup/api-keys`, `POST …/{id}/rotate`, `DELETE …/{id}`.
- **Duplicates and merge:** `POST /v1/records/{object}/duplicates/check`, `GET /v1/records/{object}/{id}/duplicates`,
  `POST /v1/records/{object}/merge`, `GET|POST /v1/duplicate-jobs`, `GET /v1/duplicate-candidates`,
  `POST …/{id}/dismiss`; Setup CRUD for matching and duplicate rules.
- **Imports:** `POST /v1/imports` (upload), `GET /v1/imports[/{id}]`, `PUT …/{id}/mapping`, `POST …/{id}/dry-run`,
  `POST …/{id}/start`, `GET …/{id}/results`, `POST …/{id}/undo`; mapping templates.
- **Routing:** Setup CRUD for assignment rules, business hours, holidays, SLA policies, recycle rules; users'
  availability, capacity and skills; `POST /v1/assignment/run`; `GET /v1/records/{object}/{id}/assignment`;
  `POST /v1/queues/{id}/take-next`, `POST /v1/records/{object}/{id}/accept`, `POST /v1/records/lead/{id}/touch`.
- **Scoring:** Setup CRUD for scoring models and rules; `GET /v1/records/lead/{id}/score-history`.
- **Forms and email:** Setup CRUD for web forms and inbound addresses; public `POST /f/v1/forms/{id}/submissions`.
- **Notifications:** `GET /v1/notifications`, `POST /v1/notifications/read`.

## 6. Test plan

- **Unit:** match keys and company normalisation, business-time arithmetic (time zones, holidays, DST), assignment
  methods (fairness over many rounds, capacity, availability), score decay, CSV/XLSX parsing and transforms.
- **Integration:** every endpoint ≥ 4 tests; duplicate rules on every capture path; merge re-parenting and history;
  assignment concurrency (two imports and a form at once never double-assign a round robin slot); SLA ladder with a
  fake clock; import undo; a form under spam and rate limits.
- **Equivalence:** the bulk path against the single-row path on random inputs.
- **FLS:** hidden fields in import mapping, form fields, duplicate panels and merge field pickers.
- **E2E + axe:** T30 journeys in light and dark.
- **Performance:** T29 at the 500k seed; added to the nightly `scale` workflow.

## 7. Risks

1. **2,000 rows/s.** The bulk path is new and the gate depends on it. If it falls short, I report at the
   mid-phase point with measured numbers before cutting anything; the next lever is parallel batches per job.
2. **Scope.** If the phase runs long, I will cut in this order and say so: XLSX (keep CSV), the form iframe (keep the
   snippet and hosted page), scheduled duplicate jobs (keep on-demand), lead recycling.
3. **Unauthenticated capture.** Forms and inbound email are abuse targets; mitigated by stored-then-processed
   submissions, rate limits, honeypot, disposable domains and an optional Turnstile.
4. **Fairness under concurrency.** Cursor locks per batch, tested with parallel writers.
5. **Session loss** from the open grace-window question can still affect users navigating fast; unchanged here.

## 8. Definition of Done for P03

Every task meets §13.4. The exit gate is evidenced: a 100k-row import with dedupe and routing in < 60 s at the 500k
seed (T29); the T30 journeys green; every capture path runs duplicate and assignment rules; `db:rls-audit` green
with every new table; coverage gates passing; P03-handoff.md written.
