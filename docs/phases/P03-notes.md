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
