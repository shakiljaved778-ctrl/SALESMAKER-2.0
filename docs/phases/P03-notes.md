# P03 working notes (input for the handoff)

Deviations from the plan or spec, calls the spec leaves open, and follow-ups, recorded as they happen.

### T01 — capture and data-quality schema

- **Migration 0022.** `api_key`, `import_job`, `import_row_result`, `import_mapping_template`, `web_form`,
  `web_form_field`, `web_form_submission`, `inbound_email_address`, `inbound_email`, `matching_rule`,
  `duplicate_rule`, `duplicate_job`, `duplicate_candidate`; `merged_into_id` on lead, contact and account;
  `tenant_settings.derived_version`. Every table has forced RLS; additive only. `import_row_result` (a §4.2 entity
  the plan's list left out) records each row's outcome, so undo knows exactly which records an import created.
- **Match keys.** Lead and contact carry `match_email`, `match_email_domain`, `match_phone`, `match_mobile`,
  `match_name_key` (lead also `match_company_key`); account carries `match_company_key`, `match_phone`,
  `match_domain`. A trigger keeps them current on every write; each has a `(tenant_id, key)` btree index, which works
  under RLS. The keys, all immutable SQL functions:
  - company: lower case, no punctuation, `&` and a leading "the" dropped, trailing legal forms removed (LLC, Ltd,
    W.L.L., FZ-LLC, GmbH, Co. KG, S.A., …): "Gulf Trading W.L.L." and "The Gulf Trading Co." both give
    `gulf trading`;
  - phone: the last eight digits, so a number matches with or without its country code or trunk prefix (Qatar and
    Bahrain numbers have eight digits); rules compare full numbers once the key has narrowed the candidates;
  - name: Double Metaphone of the surname (`fuzzystrmatch`, a contrib extension now created at bootstrap):
    Haddad, Hadad and Hadded share `HTT`;
  - email: trimmed lower case, and its domain; website: the host without scheme, `www.` or path.
- **Backfill of existing rows.** A migration runs as `sm_migrator`, which is subject to forced RLS, so an `UPDATE` in
  a migration sees no tenant rows. (Migration 0020's search-vector backfill was a no-op for the same reason; it did
  not matter because the demo data was seeded after it.) Existing rows get their keys from a worker job instead:
  `maintenance.derived_backfill` runs hourly for every tenant whose `derived_version` is behind `DERIVED_VERSION`, a
  1,000-row keyset batch per transaction with a 60 s statement timeout, then records the version, so it costs one
  query per tenant afterwards. Locally it backfilled 650k rows across 49 tenants in 310 s. Derived values only: no
  version bump, history or audit per record (as the P02 currency recalculation).
- **Routing without a tenant context.** API keys, form submissions and inbound emails arrive without a session. To
  avoid any cross-tenant lookup, the tenant id is part of the key (T04) and of the inbound address
  (`leads-{tenant}-{token}@…`, T21), and a form's URL carries the workspace (T19/T20), so each request opens the right
  tenant transaction before reading anything.

### T02 — routing, SLA and scoring schema

- **Migration 0023.** `assignment_rule` (one default per object, a partial unique index) with ordered
  `assignment_rule_entry` rows (criteria as a filter tree or a formula; one of the seven methods; `settings` for
  method options and the fallback when nobody is available), `assignment_pool_member` (users, a queue's members or an
  org unit's members, with weights), `round_robin_cursor` (last user, per-user counts for WEIGHTED, turns),
  `user_capacity`, `user_availability` (working hours, out of office with an end), `user_skill`, `assignment_log`,
  `business_hours` (one default) and `holiday`, `sla_policy` (metric, target minutes, optional calendar and owner
  time zone, ladder percentages, reassign rule) and `sla_timer` (instants precomputed at start, `next_action_at` for
  the worker, `steps_done` so each ladder step acts once), `recycle_rule`, `scoring_model` (one primary per object,
  fit weight, half-life, grade bands) and `scoring_rule`, `score_history`, `notification`. Checks keep the shapes
  honest (a SPECIFIC_USER entry has a user, a pool member names exactly one kind, ladders in range, recycle only from
  UNQUALIFIED/NURTURE, scoring points in −100…100).
- **Partitioned logs.** `assignment_log` and `score_history` are append-only (no UPDATE, DELETE or TRUNCATE for
  `sm_app`) and partitioned by month. One SQL function, `maintain_monthly_partitions(parent)`, keeps any
  allow-listed log three months ahead with forced RLS on each partition; the worker's hourly partition job calls it
  through `monthlyLogs.maintainPartitions` (`field_history` and `audit_log` keep their own functions).

### T03 — capture and score fields

- **Catalogue v3 (migration 0024).** Lead gains `lead_source_detail`, `captured_via` (picklist: entered by hand,
  import, web form, email, API; defaults to `manual`), `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`,
  `utm_content`, `referrer`, `landing_page`, `gclid`, `fbclid`, and the read-only system fields `fit_score`,
  `engagement_score`, `score` (0–100, checked) and `grade` (picklist A–D), with sort indexes for score and grade.
  Capture fields are writable so forms, imports and integrations can set them; scores refuse writes (400
  `read_only`) and are written only by the scoring engine (T16). `CATALOGUE_VERSION` 3 syncs the fields and values to
  existing organisations.
- **Layouts.** New organisations' lead layout gets a "Score" section and a "Source and tracking" section; capture
  fields stay out of Details. Existing organisations keep their layouts (sync only inserts): admins add the sections
  in the layout editor.
- **Cleanup.** The unqualified-reason value set listed "other" twice; fixed.
- **Saved view filters on hidden fields (P02 carry-over).** A shared view's saved conditions on fields the viewer
  cannot read are pruned for that viewer (empty groups disappear), like its columns and sorts, so the view runs
  instead of failing with 400; the administrator still gets the whole filter. The request's own quick filters stay
  strict (`unknown_field`). Nothing leaks: sharing and FLS still apply to every row.

### T04 — API keys

- **Key format.** `sm_live_` / `sm_test_` + base64url(tenant id ‖ key id ‖ 32 random bytes), 94 characters. The
  tenant and key ids travel in the key, so a call opens its own tenant's transaction and reads the row by primary key:
  no cross-tenant lookup, no extra index. Only the secret's SHA-256 is stored (a 256-bit random secret needs no slow
  hash); comparison is constant-time. The list shows `sm_live_…abcd` (the last four characters).
- **What a key can do.** It runs as its run-as user, with that user's profile, permission sets, sharing and FLS. The
  user must be active and hold **API enabled** when the key is created and on every call (401 for a disabled user,
  403 once the permission is removed). The spec's "integration user" is any active user an administrator picks; a
  dedicated integration user type (no UI login, no seat) is left to the licensing work in P05.
- **Where it works.** Only routes published as `public-api`: objects and describe, records CRUD and upsert by
  external id, SMQ query, search and lead conversion (now in `/v1/openapi.json`, with an `apiKey` security scheme).
  Every internal route (§10.2) answers 404 to a key, Setup → API keys included.
- **Failures.** Malformed, tampered, mis-prefixed, revoked, expired or another workspace's keys all get the same
  401 ("The API key is not valid"), so nothing about a key's existence leaks.
- **Rate limits.** A token bucket per key (`RATE_LIMIT_API_KEY_BURST` 100, `…_PER_SECOND` 10) on top of the per-IP
  limit, with `RateLimit-*` headers and `Retry-After` on 429. It fails open like the IP limit. Per-plan limits and
  the daily quota arrive with billing (P05).
- **Rotation** issues a new key (`rotated_from_id`) and keeps the old one working for an optional grace period
  (0–7 days, default 0), recorded as its `revoked_at`. Revocation is immediate and idempotent.
- **Last used** is written at most once a minute per key, not on every call.
- **Permissions and audit.** Listing needs `view_setup`; creating, rotating and revoking need `manage_users`,
  because a key acts as a user. Every change writes a Setup audit entry with the key's preview, never its secret.

### T05 — set-based bulk inserts

- **`bulkInsert(tx, ctx, object, inputs)`** (up to 1,000 rows) runs every row through the same §3.7 steps as
  `createRecord`, sharing its code (`prepareValues`, `missingRequired`, `corporateColumns`, `stripReadOnly`), but
  per batch: one reference query per lookup field (and target object), active currencies and rates read once,
  validation rules' related values read once per first-hop record (`runValidationRules(…, shared)`), ids and
  record numbers drawn as a block, one multi-row `INSERT` per 500 rows (a column a row does not set takes its default,
  as on the single path), account shares and criteria-rule shares computed over the inserted ids
  (`evaluateRulesForRecords`), one audit insert (`audit.recordMany`, one row per record) and one outbox insert.
- **Per-row results.** Rows that fail in memory are reported and never inserted. A database refusal of a row's data
  (SQLSTATE class 22 or 23) rolls back to a savepoint, splits the chunk and retries the halves until the bad row is
  alone: it is reported as 422 `invalid_value` (409 `duplicate_value` for a unique violation); anything else aborts
  the batch.
- **Equivalence.** `test/bulk-insert.test.ts` runs 160 random leads (missing and invalid fields, unknown and read-only
  fields, bad picklist values, converted status, inactive or unknown owners, inactive currencies, cross-object
  validation rules, a criteria sharing rule) and 80 random contacts through both paths and compares per-row outcomes
  and every created record's values, corporate amounts, match keys, record-number format, shares, audit entries and
  outbox events. It caught one difference on the way (required-field errors were reported apart from reference and
  currency errors) before this landed.
- **Limits.** Opportunities keep the single-row path (stages, stage history and pipelines are per record; imports of
  opportunities are not in P03's scope). Rows of one batch cannot reference each other, since lookups are checked
  before anything is inserted; the import orders parents before children.
- **Deadlocks (P02 carry-over).** `syncAccountShares` now locks the accounts it recomputes in id order
  (`FOR NO KEY UPDATE`, which does not block children's foreign-key checks), so concurrent bulk writes under the same
  accounts queue instead of deadlocking on their share rows. The bulk path also sorts the parent ids it syncs.
- **Speed.** 1,000 leads with a criteria sharing rule in ~1 s in one call on a small test database (context load
  included); throughput at the 500k seed is measured in T29.

### T06 — matching and duplicate rules

- **Conditions** (`matching_rule.conditions`): `{ field, method, threshold? }`, all of which must hold.
  `email` (normalised address), `phone` (a phone's last eight digits against both phone and mobile), `company`
  (normalised name without legal forms; lead company, account name), `email_domain_name` (same domain and same
  surname sound; leads and contacts), `exact` (case and space insensitive) and `fuzzy` (`pg_trgm` similarity ≥
  threshold, default 0.8). Blank values never match unless the rule matches blanks.
- **Candidates through keys.** Every condition on a keyed field (email, phone, mobile, last name, company or
  account name, website) also requires equal match keys, which the btree indexes resolve under row-level security
  (0.1 ms for an email rule at the 500k seed). So a fuzzy surname condition compares surnames that sound alike
  (Double Metaphone) and a fuzzy company condition compares names with the same normalised form. A rule needs at
  least one keyed condition (`conditionErrors`, used by the Setup API in T07), so no rule ever scans an object;
  fuzzy matching on arbitrary text waits on Q31.
- **One SQL builder** compares a probe side (the record or the batch, as a `VALUES` list with keys computed by the
  same `crm_*_key` functions the triggers use) with a candidate side (stored rows, using the key columns, or other
  rows of the batch). Score is the mean of the conditions (1 for key and exact matches, the similarity for fuzzy
  ones); at most ten matches per record, best first. Deleted and merged records never match; nor does the record
  being edited.
- **Duplicate rules in RecordService** (built in rather than a hook, so every write path gets them: API, import,
  forms, email, the worker). On create, or on edit when a compared field changed, per the rule's `on_create` /
  `on_edit`. **Block** refuses with 409 `duplicate_blocked` whether or not the writer can see the match, naming only
  the matches they may see; profiles in `bypass_profile_ids` save anyway. **Alert** saves and returns the visible
  matches on the write result (`duplicates`). `WriteOptions.duplicates: 'skip'` leaves rules out (for merge).
- **Bulk.** `bulkInsert` checks stored records for the whole batch in one statement per rule, at the same point as
  the single path (before validation rules), and then compares the rows still being saved with each other, so a
  row duplicating an earlier row of the same file is handled as if that row had been saved first (Block refuses
  it; Alert reports `{ batchIndex }`). A row that failed for another reason never counts as an earlier row.
  `bulkInsert(…, { duplicates: 'skip' })` serves the import's "create anyway" mode.

### T07 — duplicates API

- **Live check** `POST /v1/records/{object}/duplicates/check` (`fields` as typed, optional `id` when editing): runs
  the rules that apply to a create (or an edit), returns `blocked` (a Block rule would refuse the save, whether or
  not its matches are visible to the caller) and, per rule, the matches the caller can see with their names (read
  through the Query Engine, so sharing and FLS apply again). Unknown or unreadable typed fields are ignored.
- **Potential duplicates** `GET /v1/records/{object}/{id}/duplicates` for the record page: every active duplicate
  rule's matching rule (each matching rule once), visible matches only.
- **FLS.** A rule that compares a field the caller cannot read never shows matches, here or in a save's alerts
  (otherwise typing values would reveal a hidden field's contents); a Block still applies, without names.
- **Setup** `…/setup/matching-rules` and `…/setup/duplicate-rules` (CRUD, optimistic versions, Setup audit;
  `view_setup` reads, `customize_application` changes). Conditions are checked with `conditionErrors` (known
  field, a method that fits it, at least one keyed condition); a duplicate rule needs a matching rule of the same
  object, existing bypass profiles and at least one of create/edit; a matching rule in use cannot be deleted (409).
  `POST …/matching-rules/{id}/test` previews a rule for a record or typed values.
- These routes are internal (UI); the published API reports a Block as 409 `duplicate_blocked` on writes.

### T08 — merge

- **`mergeRecords` (RecordService) and `POST /v1/records/{object}/merge`** for leads, contacts and accounts: a
  survivor and one or two others. It needs Edit access on the survivor and the object's Delete permission with Full
  access on the others (what deleting them needs); anything the caller cannot see is 404. Converted leads cannot be
  merged (409 `record_locked`). Records are locked in id order.
- **Field winners.** `fields` maps a field to the record whose value the survivor keeps (readable fields only;
  others keep the survivor's). The survivor is written through `updateRecord` as the caller, so FLS, types,
  validation rules, history and the optimistic lock (`version`) apply; duplicate rules are skipped.
- **Children move**, set-based, for every lookup on any object that points at the merged object (standard and
  custom, live or in the bin): version, tracked-field history, audit and `record_updated` events per child,
  opportunity and account shares recomputed, criteria sharing rules re-evaluated. A record that would point at
  itself (the survivor's own parent was merged into it) is cleared. Like Salesforce, this does not need access to
  the children. **Links** (account–contact relations, contact roles, campaign members, account team members) move
  too, keeping one per counterpart (the survivor's own first).
- **The others** go to the recycle bin through `deleteRecord` (after their children moved, so nothing cascades)
  with `merged_into_id`; duplicate-review entries that name any of the records become MERGED. The survivor's
  history gets a `_merged` entry (the merged ids, shown in the history viewer whatever the FLS), and the audit log
  `record.merged` with the fields taken and the number of rows moved.

### T09 — duplicate jobs and the review queue

- **Scan.** `runDuplicateJob` claims a QUEUED job, then walks the object's live records in keyset batches of 500,
  one transaction each. Per batch a single `INSERT … SELECT` joins the batch with the table on the rule's
  conditions, both sides reading the indexed match-key columns, and writes new pairs to `duplicate_candidate` with
  sorted ids (`ON CONFLICT DO NOTHING`, so a pair already open, dismissed or merged is never queued again). Pairs
  are looked up in both directions because a phone condition is not symmetric (one side's phone against the
  other's phone and mobile). The job records `scanned`, `found`, its status and, for daily or weekly jobs,
  `next_run_at`. Groups are pairs; a record duplicated three times appears in three pairs.
- **Worker.** `maintenance.duplicate_scan` (emitted when a job is created) runs one job; the hourly
  `maintenance.duplicate_schedule` sweep runs every tenant's due scheduled jobs. Scans run in system context; what a
  user sees is decided when the queue is read.
- **API.** `GET|POST /v1/duplicate-jobs` (`view_setup` / `customize_application`, Setup audit).
  `GET /v1/duplicate-candidates?object=…&status=…` lists, best score first with a keyset cursor, only groups whose
  records the caller can all see (live records while a group is open), with their names through the Query Engine.
  `POST /v1/duplicate-candidates/{id}/dismiss` needs edit on the object (audited as `duplicate.dismissed`); merging
  from the queue goes through `POST /v1/records/{object}/merge`, which resolves the group as MERGED.

### T11 — business hours and availability

- **Business-time library** (`@sm/records` `calendar.ts`, pure): weekly open intervals (`HH:MM`, end exclusive,
  `24:00` allowed) in an IANA zone, one-off and recurring holidays; `isOpen`, `addBusinessMinutes` (zero minutes
  from a closed instant is the next opening; null for a calendar that never opens, after three years of looking),
  `businessMinutesBetween`, `zonedInstant` and `localParts`. Daylight saving through `Intl` with no library: a
  wall time that happens twice takes the earlier instant, one that never happens lands just after the gap. Tested
  in Doha (no DST, Sunday–Thursday with a lunch break) and New York across both changes.
- **`loadCalendar(tx, id | null)`**: the given set, else the default set, else always open in the organisation's
  time zone.
- **Setup → Business hours** (`/v1/setup/business-hours`, CRUD with holidays replaced as a whole, one default,
  optimistic versions, Setup audit; a set used by SLA policies cannot be deleted).
- **Users' routing settings** `GET|PUT /v1/users/{id}/routing`: working hours (null: whenever not out of office),
  out of office with an optional end, skills and per-object capacity. Users read and change their own availability;
  `view_setup` reads anyone's; skills and capacity need `manage_users`. Audited.

### T10 — assignment engine

- **`assignRecords(tx, env, object, ids, { source, ruleId? })`** (RecordService): the given rule or the object's
  active default; entries in order, the first whose criteria match decides. Criteria are a filter tree and/or a
  Boolean formula compiled to SQL (`filterSqlWith` over `fieldExpr`, `compileToSql`), so each entry is one statement
  over the batch. An entry that no longer compiles never matches (Setup refuses to save one).
- **Methods.** ROUND_ROBIN (next eligible user after the cursor's last, in id order), WEIGHTED (the eligible user
  furthest below their share, counts kept on the cursor), LOAD_BALANCED (fewest open records: leads by status
  category, default OPEN/WORKING/NURTURE; opportunities not closed), SKILLS_BASED (every required tag, plus
  `<field>:<value>` from a record field such as `city:doha`; ties by load), STICKY_ACCOUNT (owner of the account
  the record belongs to, or for a lead the account with the same normalised company; no account → the next entry),
  QUEUE and SPECIFIC_USER.
- **Availability and capacity.** A user is skipped when inactive, out of office (until `ooo_until`), outside their
  working hours (in their time zone), at `max_open` or at `max_new_per_day` (assignment log, organisation's day).
  Counts include what the same batch has already handed out. Nobody available: the entry's fallback (user or queue),
  else the owner is kept and the log says so.
- **Concurrency.** Each entry's `round_robin_cursor` row is created if missing and locked `FOR UPDATE` once per
  batch, records `FOR UPDATE` in id order; concurrent batches take turns in sequence (tested: three batches at once
  hand out eight records 2/2/2/2).
- **Writes.** Owners set-based with version, tracked-field history, shares (account children, opportunity and
  implicit account shares), owner-based sharing rules, audit `record.assigned` (system actor when no user), events
  `automation.owner_changed` and `assignment.assigned` (consumed by SLA timers and notifications in T13/T14), and one
  `assignment_log` row per decision with every candidate and why it was skipped. The log is stamped with the real
  time; the injected clock decides availability only.
- **Where it runs.** `createRecord(…, { assign: { source } })` and `bulkInsert(…, { assign })` for capture paths
  (import, forms, email, API in T17–T21); `POST /v1/assignment/run` (needs `transfer_records`; per record Full
  access, else `not_found` / `forbidden` in the results); `GET /v1/records/{object}/{id}/assignment` explains the
  last 20 decisions with names. Setup → Assignment rules CRUD (entries and pools replaced as a whole, one default per
  object, targets and pool members checked, queues must serve the object).

### T12 — queue pick-up

- **`takeFromQueue`** (RecordService): one statement selects the queue's record `FOR UPDATE OF r SKIP LOCKED`,
  highest score first (leads), then oldest, so members taking at the same moment each get a different record
  (tested with two concurrent calls). The owner is written through the same set-based path as assignment (version,
  history, shares, audit `record.assigned`, events) and logged in `assignment_log` with source `take_next` or
  `accept`.
- **API.** `GET /v1/queues/mine` (the caller's queues, with what waits per object), `POST /v1/queues/{id}/take-next`
  (members only, 403 otherwise; `{ id: null }` when the queue is empty) and `POST /v1/records/{object}/{id}/accept`
  (409 when no queue owns the record any more). Both need edit on the object. Queue views themselves are list views
  filtered on the owner: queue members already see what their queues own (the visibility closure includes queue
  ownership and is rebuilt on membership changes).

### T13 — SLA policies and timers

- **Clocks start at assignment** (the assignment engine and queue pick-up call `startSlaTimers` in the same
  transaction): every active lead policy whose criteria match starts once per record (a cancelled clock may start
  again). Its ladder is computed at start in UTC with business-time arithmetic over the policy's business hours (or
  every minute without), in the owner's time zone when the policy says so: warn at `warn_at_percent`, breach at
  100 %, the manager at `manager_at_percent` (up to 500 %), reassign at `reassign_at_percent` through the chosen rule.
  Open clocks (running, or breached and not yet met) follow the record to a new owner and keep running.
- **Stopping.** First touch: `POST /v1/records/lead/{id}/touch` (edit access; P04's activity logging will call the
  same `meetSlaTimers`). Qualify: a lead moved to a QUALIFIED or CONVERTED status. A clock stopped late stays BREACHED
  with its `met_at`. Unqualified or deleted leads cancel their running clocks.
- **Worker** `maintenance.sla_tick` every minute, per tenant: claims due timers `FOR UPDATE SKIP LOCKED` in batches
  of 500 and acts on each step once (`steps_done`): notifications (`sla_warning`, `sla_breach`, `sla_escalation` to
  the owner's manager; queue owners get none), breach status and audit, and reassignment through the assignment
  engine with source `sla`. Loops until nothing is due.
- **API.** Setup → SLA policies CRUD (criteria checked, business hours and reassignment rule must exist, a
  reassignment step needs a rule; clearing criteria applies the policy to every lead), `GET /v1/records/lead/{id}/sla`
  and `POST /v1/sla/status` (up to 200 ids, only visible ones) with a chip state: on track, at risk (past the warning),
  breached, met, cancelled.
- **Notifications** are written now (`notify`: rows plus an `automation.notification_created` cue per user); the
  read API is T14. New owners get an `assignment` notification unless they assigned themselves.
- **Found on the way:** the automation consumer rejected `automation.lead_converted` (P02) and would have rejected
  `automation.record_merged` (T08), sending them to the dead-letter queue. Both are acknowledged now, and a test
  checks every `automation.*` topic RecordService emits against the consumer.

### T14 — in-app notifications

- **Writes** come from RecordService (`notify`, T13): `assignment` for a new owner who did not assign themselves,
  `sla_warning`, `sla_breach` and `sla_escalation`. Each kind carries parameters, never field values, so a
  notification never shows a field the reader could not see (§6.5); the UI words them per kind.
- **API.** `GET /v1/notifications` (the caller's own, latest first, keyset cursor, `unread=true`, with the unread
  count) and `POST /v1/notifications/read` (`ids` or `all`). Another user's ids are simply not updated.
- **Realtime.** Every write emits `automation.notification_created` per user (acknowledged by the automation
  consumer). The WebSocket gateway (`apps/realtime`, not built yet) will turn it into the "refresh your bell"
  invalidation; until then the bell refreshes when fetched.

### T15 — lead recycling

- **`recycleLeads`** (RecordService) per rule: leads in a status of the rule's categories (Unqualified, Nurture),
  untouched for `after_days` (no change of any kind: `updated_at`, since lead status is not history-tracked by
  default), not converted, matching the rule's criteria, in batches of 500 claimed `FOR UPDATE SKIP LOCKED`. They move
  to the rule's open status (the unqualified reason is cleared) set-based with version, status history when tracked,
  audit `record.recycled` (system actor) and events, then are routed again through the rule's assignment rule (or the
  default), which logs them with source `recycle`, notifies the new owner and starts SLA clocks. Validation rules are
  not run: recycling is the platform acting on stale records, not a user edit.
- **Worker** `maintenance.lead_recycle` nightly (03:23 UTC), every tenant with active rules, until nothing is left.
- **Setup → Lead recycling** CRUD (`/v1/setup/recycle-rules`): the target must be an open lead status, criteria must
  compile, the assignment rule must be a lead rule; clearing criteria applies the rule to every lead.

### T16 — rules-based scoring

- **Model.** One primary model per object (leads in P03) with FIT rules (a Boolean formula worth −100…100 points)
  and ENGAGEMENT rules (points per `form_submission` or `inbound_email`; activities join in P04). Fit is the sum of
  matched rules capped 0–100 and decides the grade (bands A/B/C, below C is D); engagement sums each event's points
  halved every `engagement_half_life_days`, capped 0–100; score = fit and engagement weighted by `fit_weight`, 1–100.
- **One statement per batch.** FIT formulas compile to SQL (`compileToSql`), so scoring 1,000 leads is one select
  for fit (which rules matched, for the reason) and one for events. Formulas that cannot compile (cross-object fields,
  pending-write functions) are refused in Setup.
- **When.** On every lead write through RecordService (create, update, bulk insert), after the model changes (Setup
  emits `maintenance.score_recalc`; the worker rescores the tenant in keyset batches), and nightly
  (`maintenance.score_nightly`, 02:07 UTC) so engagement decays. Capture paths (T19, T21) rescore after recording
  their events.
- **Derived columns.** `fit_score`, `engagement_score`, `score`, `grade` are written without a version bump or audit
  (system fields, like match keys); a `score_history` row records each change with its reasons. History keeps the
  grade letter (A–D); the lead's picklist value is lower case (a–d).
- **API.** Setup → Lead scoring CRUD (`/v1/setup/scoring-models`, rules replaced as a whole, one primary) and
  `GET /v1/records/lead/{id}/score-history` (visible leads; empty when the score field is hidden by FLS).

### T17 — import engine

- **`@sm/imports`.** Reading (`parse.ts`), mapping (`mapping.ts`) and running (`run.ts`) imports, on the worker's
  `import` queue (`import.run`, `import.dry_run`, `import.undo`, payload `{ jobId }`).
- **Files.** CSV is streamed by `csv-parse` (delimiter `,` `;` or tab, BOM stripped). XLSX is read with `fflate`
  (MIT, unzip) and `saxes` (ISC, SAX XML): sheets in workbook order, shared and inline strings, booleans, and dates
  decided by the cell's number format. `exceljs` was rejected on licence grounds (it pulls in Unlicense, Zlib and
  unlicensed transitive packages, which §0.3 rules out).
- **Mapping.** Each column → field with picklist value maps (any case; labels match too), date order (DMY/MDY/YMD;
  ISO always), a default phone country, owners by email/name/id, numbers with either decimal separator, currency
  symbols and `%`, and checkboxes in words. Unconvertible cells are row errors; job defaults fill empty fields.
  `suggestMappings` (API names, labels, synonyms) and `headersSignature` (saved templates) serve T18.
- **Run.** The job is claimed `QUEUED → RUNNING` once. Rows go in batches of 1,000, one transaction each, through
  `bulkInsert`/`bulkUpdate` as the importing user (validation, FLS, duplicates, assignment, scoring, audit, events all
  as for any write). Duplicate handling uses the job's matching rule: **SKIP** the row, **UPDATE** the best match the importer can see
  (a match they cannot see is a row error, never touched), or **CREATE** regardless. A batch that loses a deadlock or serialization
  race (40P01/40001) is retried up to 3 times. Each row's outcome is stored (`import_row_result`) and a results CSV
  (row, status, record id, errors) is written to object storage when the job finishes.
- **Dry run.** The first 100 rows run in one transaction that is then rolled back (a `DryRunDone` throw carries the
  outcomes out); the counts and row errors are kept on the job, which becomes READY.
- **Undo.** Within 72 hours of finishing, the job moves to UNDOING (API, T18), then the worker moves its CREATED
  records to the recycle bin as the importing user, skipping records already gone, and marks it UNDONE. Updated
  records are not reverted; their field history shows what the import changed.
- **Storage.** `StorageProvider` gained `putObject`/`getObject`; `S3StorageProvider` (AWS SDK v3, path-style for
  S3-compatible stores) is used when `S3_*` is configured. Without it the worker still runs mass actions and refuses
  import jobs. The fake keeps bytes in memory for tests. The record test harness moved to `@sm/records/testing` so
  other packages' tests share it.

### T18 — imports API

- **Flow.** `POST /v1/imports` creates the job and returns a 15-minute pre-signed `PUT` URL for exactly the declared
  size (§3.12; the file never passes through the API). `POST /v1/imports/{id}/analyse` reads the uploaded file
  outside any transaction: XLSX sheets, the header row (chosen by the user, default 1) and five sample rows, then
  stores the headers and suggests a mapping. `PATCH` sets mapping, duplicate mode, matching rule, assignment and
  defaults (optimistic `version`); `dry-run`, `start`, `cancel` and `undo` queue the T17 worker jobs; `rows` pages
  the per-row outcomes; `results` gives a 5-minute download URL; `/v1/import-templates` saves mappings.
- **Suggestions.** The caller's last completed import of a file with the same headers wins; otherwise API names,
  labels in the caller's language and synonyms. Only fields the caller can edit (FLS) are suggested or accepted.
  Saved templates whose header signature matches are listed with the analysis.
- **Validation.** Columns within the header row, each field once, transforms only on fields of their type
  (`values` on picklists, `dateOrder` on dates, `phoneCountry` on phones, `ownerBy` on owner), defaults only on
  editable fields, matching and assignment rules of the same object; SKIP/UPDATE need a matching rule. Any change
  clears an earlier dry run. Unreadable files are `file: unreadable_file`; a header row with nothing in it
  `headerRow: no_headers`.
- **Limits.** CSV up to 500 MB (streamed), XLSX up to 100 MB (read whole: it is a zip). Wholly blank rows are not
  data and are skipped by the engine for CSV too (XLSX already dropped them).
- **Access.** Every route needs `import_records` (System Administrator by default; Standard User does not hold
  it). A job belongs to the user who started it: only they configure, run, cancel or undo it, since the worker
  runs it as them. Holders of `view_setup` read everyone's history (`?mine=true` narrows it) and get 403 on
  changes; other users and tenants get 404. Importing into an object needs Create on it (403; 404 when it cannot
  be read). Templates are shared by everyone who can import into the object.
- **Storage.** The API takes `S3_*` like the worker (`s3StorageFrom` in `@sm/integrations`, shared); without it
  import routes that need files answer 503. Tests inject the fake. Uploading from the browser to the local S3
  store needs CORS on the bucket; T22 sets that up with the wizard.
- `import.started` and `import.undone` go to the Setup audit trail; the records themselves are audited by
  RecordService as for any write. Undo now stamps `undone_at` (it overwrote `finished_at`, which the 72-hour
  window is measured from).

### T19 — web-to-lead

- **Capture pipeline** (`@sm/records` `captureLead`, shared with email-to-lead in T21). The lead is created through
  RecordService as the capture point's run-as user, inside a savepoint so a refusal never aborts the caller's
  transaction. Values: the visitor's, then the capture point's defaults for what is empty, then the source fields
  (`lead_source` defaulting to `web`/`email`, `lead_source_detail` = the form's or address's name, `captured_via`,
  UTM fields, `referrer`, `landing_page`, `gclid`, `fbclid`; long values are cut, never refused). **Campaign
  attribution:** a `campaign_id` default wins; otherwise a campaign whose name equals `utm_campaign` (any case), when
  exactly one does. Duplicate rules run as for any write; when a **Block** rule stops the lead, the submission is
  `DUPLICATE` and linked to the existing lead (best match under the active matching rules, whatever the run-as user
  can see). The caller stores its event (submission, inbound email) and then the lead is rescored, so the event
  counts towards engagement on the new or the existing lead. The capture point's assignment rule routes it.
- **Setup → Web forms** (`/v1/setup/web-forms`, view_setup / customize_application, audited): fields from lead
  metadata with label overrides, required flags, hidden fields with values, picklist subsets; consents (up to 5,
  keyed, optionally required); theme, button label, thank-you message or https redirect; Turnstile; extra blocked
  domains; defaults; assignment rule; auto-responder. Everything that would make submissions fail is refused up
  front: a run-as user who is inactive, cannot create leads or cannot edit a field the form sets; visible fields
  of types visitors cannot fill (lookups come from hidden fields or defaults); hidden fields without values;
  picklist values that are not active; a required lead field nobody fills (the owner and picklist defaults count,
  as RecordService fills them); Turnstile without keys; an auto-responder without an email field. Submissions are
  listed per form with their attribution, never the visitor's values, IP hash or user agent.
- **Public endpoints** (`/v1/public/forms/{tenantId}/{formId}`, no session; tenant by id like every pre-auth route,
  the web resolves the slug): `GET` describes an ACTIVE form (visible fields only, labels in the visitor's locale, options);
  `POST …/submissions` → 202. Order: tenant and ACTIVE form (else 404, nothing leaks); per-IP token bucket per
  form (`FORM_RATE_BURST`, `FORM_RATE_PER_HOUR`; 429 with `retry-after`; fails open); **honeypot** (`website`
  filled → stored `REJECTED`, answered exactly like a success); **Turnstile** when the form uses it (400
  `captcha_failed`); values checked against the form (unknown fields, required, types, picklist subset, email and
  URL shapes, **disposable domains** from the bundled list plus the form's own, required consents) → 400 with every
  problem, nothing stored; then the submission is **committed** (`RECEIVED`, payload, attribution, a keyed hash of
  the IP, user agent) before a second transaction captures the lead and sets `CREATED`/`DUPLICATE`/`FAILED`. An
  unexpected error marks it `FAILED` (`internal_error`) and the visitor still gets 202: the submission is safe.
- **Auto-responder** after commit through EmailSender (Mailpit locally), plain text with `{first_name}` /
  `{last_name}`, HTML-escaped, idempotent per submission; failures are logged, never surfaced.
- **Turnstile** behind `CaptchaVerifier` (`TurnstileVerifier` posting to `siteverify` with the token and IP only;
  `FakeCaptchaVerifier` in tests: `pass` passes). On when `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are set.
- **Disposable domains:** the hand-made list (33 well-known services) in `capture/disposable-domains.ts`, matched on
  the domain and its parents, plus each form's `blockedDomains` (approved plan decision; no CC0 list).
- T20 note: the hosted page and embed call these endpoints; browser calls from other origins need CORS and the web
  server must forward the visitor's IP (trusted proxy) so the per-IP limit sees visitors, not the web server.

### T20 — hosted forms and embed

- **Hosted page** `/f/{slug}/{formId}` on the web app (locally on the apex, `localhost:3000/f/…`; in cells on
  `forms.{base}/f/…`, where the short `forms.{base}/{slug}/{formId}` redirects to it). The server component resolves
  the workspace by slug through the tenant directory and loads the form from its cell's public endpoint, so the
  browser only talks to this origin. Unknown, suspended or inactive → the plain 404 page; a directory or cell outage
  → "briefly unavailable", never a 404. A pending workspace is left to the cell: the directory may hold a workspace
  as pending for up to its cache TTL (60 s) after activation.
- **Submissions** go to the same-origin relay `POST /api/forms/{slug}/{formId}` (same-origin only, 64 KB cap),
  which forwards to the cell with the visitor's address as `X-Forwarded-For` (the **last** hop, the one our load
  balancer or the Next server appends; earlier hops are client claims) and user agent, and relays the cell's
  answer and problems (with `Retry-After`).
- **Form UI** (`components/forms/public-form.tsx`): `@sm/ui` FormField/Input/Textarea/Select/Checkbox per field type,
  multi-picklists as a checkbox group, consents, an off-screen honeypot (`website`, not focusable), Turnstile when
  the form uses it (script loaded on demand), required checks before sending, the cell's field errors mapped back
  (`fields.x`, `consents.k`, `turnstileToken`) with a summary banner, 429 as "too many from your network", then the
  thank-you message (focused, `role=status`) or the redirect. Attribution: UTM and click ids from the address, the
  landing page and referrer (or the embedding page's, from the embed script). Strings under `forms.*`.
- **Theme:** the form's own theme applies whatever the visitor's preference: `@sm/ui` tokens now also render for a
  subtree with `data-theme-scope="light|dark|system"` (generated by `renderTokensCss`), set on the page's wrapper.
  Locale: `?locale=` when it is a UI locale, else the visitor's preference cookie; `lang`/`dir` on the wrapper.
- **Embed** (`/forms/embed.js`, static, cacheable 5 min, `Cross-Origin-Resource-Policy: cross-origin`):
  `<div data-sm-form="…/f/{slug}/{id}" data-sm-title="…">` becomes an iframe with `embed=1`, the page's UTM
  parameters and click ids, `landing` and `referrer`. The form posts its height (auto-resize) and, after a
  submission with a redirect URL, asks the page to follow it (https only); the script accepts messages only from that
  iframe's window and origin. A plain `<iframe src="…?embed=1">` works too. T27 generates both snippets.
- **Framing and CSP:** only `/f/…` is framable: `frame-ancestors *` in its CSP (via the proxy) and no
  `X-Frame-Options` there; every other page keeps `frame-ancestors 'none'` and `DENY`. Form pages also allow
  `https://challenges.cloudflare.com` for scripts, frames and connections (Turnstile).
- **Capture fix found by the e2e:** attribution values a field will not take (e.g. a `http://localhost` landing page
  for a URL field) are now dropped by `captureLead` rather than failing the lead.
- **Tests:** relay and loading units (`test/forms.test.ts`), CSP for form pages, and an e2e journey: validation,
  a disposable address refused on its field, a lead with UTM attribution, axe in light and in the form's dark theme,
  and the embed on another (loopback) site with its height reported. Chromium's Private Network Access blocks
  public pages from loading scripts from `localhost`, so the test's "customer site" is a loopback server; deployed,
  the forms host is public.

### T21 — email-to-lead

- **Addresses** (Setup → Email-to-lead, `/v1/setup/inbound-addresses`, view_setup / customize_application,
  audited): `leads-{token}@{INBOUND_EMAIL_DOMAIN}`, with a run-as user (active, can create leads and set every
  default), defaults and a lead assignment rule; `rotateAddress` issues a new address and the old one stops working.
  Mail reaches the cell before it knows the workspace, and row-level security needs a tenant before any lookup, so
  the token carries the tenant id (16 bytes) plus 10 random bytes in lower-case base32 (42 characters, like API keys
  carry theirs); it must still match a stored ACTIVE address.
- **Inbound adapter** (`@sm/integrations`, `InboundEmailSource`): **SES** in cells — a receipt rule stores the message
  in the cell's bucket (S3 action) or inlines it (SNS action, Base64) and notifies an SNS topic subscribed to
  `POST /v1/inbound/email`; `SesSnsInboundSource` accepts only the configured topic (`INBOUND_SES_TOPIC_ARN`), a valid
  SNS signature (v1 SHA1 / v2 SHA256, certificate fetched only from `sns.*.amazonaws.com` and cached), less than an
  hour old, and confirms its subscription itself. **Shared secret** locally and in tests (`INBOUND_EMAIL_SECRET`,
  `x-sm-inbound-secret`, `{ recipients, raw }` base64). Anything else is 401. No real AWS call happens in CI.
- **Delivery** stores, per recipient that is an ACTIVE address in this cell, the raw message under the tenant's
  storage prefix and an `inbound_email` row (sender, name, subject, Message-ID; once per Message-ID, idempotent), and
  emits `email-sync.inbound_lead`. Unknown, inactive or rotated addresses are dropped silently; messages over
  `INBOUND_EMAIL_MAX_BYTES` (10 MB) are dropped and logged.
- **Processing** (worker `email-sync` queue → `@sm/imports` `processInboundEmail`): the row is claimed
  (`FOR UPDATE SKIP LOCKED`, RECEIVED only), the MIME parsed with **mailparser** (MIT; HTML-only mail converted with
  html-to-text, MIT; its nodemailer dependency is MIT-0 as accepted in P00, mailsplit MIT-or-EUPL taken as MIT). A
  **known sender** (an open lead, else a contact, by email) gets the email stored on that record (`MATCHED`; P04
  turns these into activities) and a lead is rescored. Otherwise a lead goes through the capture pipeline as the
  run-as user: name split from the display name (else the local part), company from a business domain
  (`acme-group.co.uk` → `Acme-group`; mailbox providers say nothing), else the address's default, else the sender
  stands in; subject and text in `description`; `captured_via` = `email`, `lead_source` = `email` unless defaulted.
  `CREATED`, `MATCHED` (a Block duplicate rule linked it to an existing lead) or `FAILED` with the reason. Signature
  parsing is P07 (AI).
- **On records:** `GET /v1/records/{lead|contact}/{id}/inbound-emails` (and `/{emailId}` with the text, parsed
  from the stored original) for callers who can see the record (404 otherwise) and read its email field (else an
  empty list).

### T22 — import wizard (T6)

- **Route** `/{leads|accounts|contacts}/import` (More list actions → Import; the API decides who may import), with
  `?job=` so a reload resumes the job where it left off; `/{section}/import/history` lists the caller's imports and
  Setup → **Data import history** (`/setup/data-import`, new "Data management" group) everyone's.
- **Template T6:** centred 720 px column, `Stepper` on top (new in `@sm/ui`, with stories and a test: done steps
  jade with a check, `aria-current="step"`), one decision per step, Back/Next in a sticky footer, a preview panel
  on the mapping step. Steps: **Upload** (drop zone or picker, CSV/XLSX, upload progress) → **Headers** (sheet for
  XLSX, header row, the first rows) → **Map fields** (column, example, field among the ones the caller can edit or
  the row currency; date format, phone country code, owner by email/name/id, picklist value mapping in a dialog;
  apply or save a mapping template) → **Duplicates** (skip/update/create with a matching rule; assignment rules,
  default or chosen) → **Review** (summary and the 100-row test with its counts and problem rows) → **Import**
  (live counts while the worker runs it, results download, failed rows, undo with confirmation).
- **Uploads go straight to object storage** through the pre-signed PUT (§3.12), with progress. Two fixes made it
  work: the S3 client now computes checksums only when S3 requires them (`requestChecksumCalculation:
'WHEN_REQUIRED'`), since a pre-signed URL carrying the SDK's CRC32 of an empty body is refused with BadDigest; and
  the app's CSP lets it reach the storage origin (`STORAGE_PUBLIC_ORIGIN`, connect-src; never on form pages). The
  store must allow the web origins by CORS: `pnpm storage:setup` creates the local/CI bucket with CORS for the apex
  and `*.{WEB_BASE_DOMAIN}`; cells get theirs from Terraform.
- **Rules lists:** matching and assignment rules are listed for the choice only when the caller can read Setup; an
  importer without view_setup can still import, creating every row.
- **CI e2e** now starts SeaweedFS (`s3`), runs `pnpm storage:setup`, and starts the **worker** (imports, dry runs
  and undo run there). New journey `e2e/imports.spec.ts`: upload, auto-mapping, skip a duplicate by a matching rule,
  the test run's counts, the run (2 created, 1 skipped, 1 failed), failed rows, undo, history, axe on each screen.

### T23 — duplicates UI

- **Record pages** (lead, contact, account) show a warning banner when the active duplicate rules find visible
  matches: each match with its rule and score, links, and — for users who can edit and delete — up to two picked for
  a merge. Nothing is shown when there are none.
- **Block in forms:** a save refused by a Block rule shows the rule's name and the matches the user can see (from
  `duplicates/check` with the typed values; "not shared with you" when none are visible), instead of a generic error.
- **Merge modal:** 2–3 records side by side; the record that stays, then a winner per field among the editable
  fields whose values differ (default: the survivor's value, else the first non-empty one); sends only the fields won
  by another record, with the survivor's version.
- **Duplicate review** (`/{leads|contacts|accounts}/duplicates`, template T7, More list actions → Review
  duplicates): open groups from duplicate jobs in a 360 px list, the selected group's records compared on key fields,
  **Merge…** and **Not duplicates**.
- **Setup → Matching & duplicate rules** (Data management): matching rules with a condition builder (field, compare
  as exact/similar/phone/email/email domain and name/company, similarity threshold), match-blank, active, and a
  "try it" preview with typed values; duplicate rules (matching rule of the same object, Block or Alert, on create
  and/or edit, bypass profiles for Block, active); duplicate jobs (scan once, daily or weekly; status, scanned,
  groups found).
- Server pages may only import constants from plain modules (`duplicates/objects.ts`): from a `'use client'` file
  they arrive as client references (`DEDUPE_OBJECTS.has is not a function` in SSR).
- e2e `duplicates.spec.ts`: rules made in Setup, a Block naming the rule and linking the match, an Alert's banner,
  a merge from the record page (the other record gone), a scan feeding the review queue, Not duplicates; axe.
