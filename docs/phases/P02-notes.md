# P02 working notes (input for the handoff)

Deviations from the plan or spec, calls the spec leaves open, and follow-ups, recorded as they happen.

## Decisions the spec leaves open

- **Standard metadata is synced, not migrated (T01).** `syncStandardMetadata()` inserts whatever a tenant is
  missing from the catalogue (objects, fields, picklist values, a Master record type, default page and compact
  layouts, the record-number format, the All / Mine / Recently viewed list views) and records
  `tenant_settings.catalogue_version`. It runs at signup and in the seeds, and the metadata service (T02) runs it
  for any tenant behind `CATALOGUE_VERSION`, so existing organisations catch up without a data migration. It only
  ever inserts: admin renames, extra values and layout edits survive a later sync.
- **Defaults are named in the organisation's language (T01)**, like the built-in profiles in P01: layouts, the
  Master record type and system list views get their names from i18n at creation; picklist values keep a null
  label and are labelled from `picklists.<set>.<value>` until an admin renames them.
- **Picklist values are lower snake_case (T01).** Lead status and forecast category values also carry their system
  category (`OPEN`, `COMMIT`, …); reports, AI and forecasting use the category, admins rename only labels.
- **Field history settings are a column (T01).** §4.2 lists a `field_history_setting` table; a `track_history` flag
  on `field_definition` holds the same thing with one fewer join. The 60-per-object cap is a constraint trigger.
- **Layout assignments are overrides (T01).** Every object has one default page layout; `layout_assignment` rows
  exist only where a profile × record type should see a different one, so new profiles need no rows.
- **Auto-numbers use per-field sequences (T01).** `auto_number_next(field)` draws from a sequence created on first
  use (the `audit_next_seq` pattern), so concurrent creates never queue on a counter row. Numbers can have gaps, as
  in Salesforce.
- **Metadata runtime (T02).** `loadTenantMetadata()` (@sm/db) reads every metadata table in one pass into plain
  JSON (`TenantMetadata`, types in @sm/metadata); `MetadataCache` keeps it in process (LRU, 500 tenants) and in
  Valkey under `meta:{tenant}:{metadataVersion}`; `MetadataIndex` adds the lookups (fields, name fields, the
  layout a profile sees, record-type picklist values). The worker can use the same pieces. The API's
  `MetadataService.forTenant()` syncs a tenant behind the catalogue first, inside the caller's transaction.
- **Field values (T02).** `normaliseValue()` is the one check for a value written to a field (§5.3): text lengths
  (text 255, textarea 4,000, long and rich text 128 Ki by default), e-mail, phone (4–20 digits), URLs (http/https
  with a dot in the host; `https://` added when missing), numbers and money as decimal strings rounded half-up to
  the scale (number 0, currency and percent 2, precision 18), real calendar dates, date-times with an explicit
  offset stored in UTC, picklists limited to active (or record-type) values. Computed and system fields refuse
  writes. A Decimal library (`decimal.js` 10.6.0, MIT) is added for this, per §0.4 rule 8.
- **Required custom fields are always visible (T02).** `fieldAccess()` takes the field's own system/required flags
  for fields outside the catalogue, so a required custom field is readable and editable with the object, as
  standard required fields already were.
- **Formula syntax (T03).** Field references are snake_case API names, case-insensitive; related records are
  reached through a lookup's relationship name (`account_id` → `account`, `partner__c` → `partner__r`, or the
  field's own `relationship_name`), up to 5 hops; `owner`, `created_by`, `record_type` and `pipeline` end on a
  small set of platform fields (name, email, …). `==` and `<>` are accepted as `=` and `!=`; `/* … */` comments;
  text in single or double quotes with `\n \t \\ \' \"` escapes. Formulas are capped at 5,000 characters and
  100 levels of nesting.
- **Formula types (T03).** Beyond §5.5's list, `Time` and `MultiPicklist` exist so every §5.3 field has a type.
  Picklists are compared only through `ISPICKVAL`, `TEXT`, `ISBLANK` and `CASE` (Salesforce's rule); money stays
  Currency through `+ - * /` with plain numbers, and Currency ÷ Currency is a Number. `CASE` needs an else value.
  `DATEDIFF(start, end)` (not in Salesforce) counts whole days; `BUSINESSDAYS(start, end)` counts Monday–Friday
  days until business hours exist (P03). Errors are codes with parameters and a span; the editor translates
  `formula.errors.<code>` (keys land with the editor, T25).
- **Formula evaluation (T04a).** Numbers are Decimals with 34 significant digits, rounding half away from zero;
  results are rounded to the field's scale only when stored. Blanks follow "treat blanks as blanks": arithmetic
  with a blank is blank, `x = null` asks "is x blank" (`''` counts), ordering comparisons with a blank are false,
  `&` treats a blank as `''`, and a blank checkbox is false. `IF`, `AND`, `OR`, `&&` and `||` short-circuit.
  Division or `MOD` by zero, impossible `DATE`s, non-numeric `VALUE` text and huge powers are runtime errors
  (codes with spans). `TODAY()` is taken in a given time zone (the user's, else the organisation's); date
  arithmetic counts days; `ADDMONTHS` keeps month-end dates at month end; `REGEX` must match the whole text and
  runs on at most 10,000 characters. Text lengths count code points, as Postgres `char_length` does.
- **Formulas in SQL (T04b).** `compileToSql()` turns a checked formula into a Postgres expression with the
  evaluator's semantics (blanks, three-way comparisons, code-point text ordering, month-end `ADDMONTHS`, days in
  date arithmetic). It is proven equal to the evaluator over a set of rows for 120 hand-written formulas and 300
  random well-typed ones, compared to 12 decimal places (Postgres division keeps about 16 decimals, the evaluator
  34 significant digits). What cannot run in a query is refused as `not_filterable`: `ISCHANGED`/`PRIORVALUE`/
  `ISNEW`, `REGEX` (unbounded cost in the database), `VALUE`, `INCLUDES`, `BUSINESSDAYS`, `ADDMONTHS` on
  date-times and fields of other objects. Where the evaluator raises a runtime error (division by zero) the SQL
  yields NULL, so the row simply does not match. A parser fuzz (3,000 random inputs) only ever produces syntax
  errors.
- **CRM tables are generated from the catalogue (T05).** The Prisma models for lead, account, contact,
  opportunity and campaign carry exactly the catalogue's standard fields as typed columns, plus the §4.1 columns,
  `custom jsonb`, a search document, and for money objects `currency_code`, one `<field>_corporate` column per
  standard currency field and `corporate_rate_date`. Number fields are integers (`number_of_employees`),
  percents `numeric(5,2)`, money `numeric(18,2)`, multi-selects `text[]`.
- **Lookups are logical references (T05).** CRM lookups have no foreign keys: Postgres's `ON DELETE SET NULL` on a
  composite `(tenant_id, x_id)` key would null the tenant too, and deletes go through the recycle bin anyway.
  RecordService checks that a lookup target exists and is visible; purge clears references (T09). Structural
  links keep foreign keys (pipeline stages, a record type's pipeline).
- **Search documents hold only what every reader sees (T05).** The trigger-maintained `search_vector` holds the
  record name (first and last name for people, weight A) and a lead's company (weight B). Fields FLS can hide
  (e-mail, phones, …) are matched per column at query time only when the searcher can read them (T14), so a hidden
  field never decides whether a record is found (§6.5). First name is treated as part of the record name here, as
  in Salesforce's compound Name. GIN indexes lead with `tenant_id` (`btree_gin`) and skip deleted rows.
- **Indexes (T05).** Each object has `(tenant_id, owner_id)` for sharing, and for its likely sort fields both
  `(tenant_id, field, id)` and `(tenant_id, owner_id, field, id)` (the P01 T22 finding); lookups used by related
  lists are indexed. T28 revisits these with measured plans at 500k rows.
- **Default pipeline (T05).** Every organisation gets a "Sales pipeline" (qualification → needs analysis →
  proposal → negotiation → closed won / closed lost, with default probabilities and forecast categories) that the
  opportunity Master record type uses; `CATALOGUE_VERSION` 2 brings existing organisations up to date.
- **Record support tables (T06).** `field_history` is partitioned monthly on `changed_at` (PK
  `(tenant_id, changed_at, id)`, Q12), append-only for the runtime role, with partitions kept three months ahead by
  the worker's hourly maintenance job alongside the outbox and audit partitions; retention drops arrive with P12.
  `recycle_bin_item` holds one row per deleted record with its display name, who deleted it, the item it
  cascaded from and when it may be purged. `recent_item` keeps a user's latest view per record. Exchange rates are
  stored as units of the currency per one unit of the corporate currency, one rate per currency per day.
  Account team members carry their own access and the access they get to the account's opportunities.
- **SMQ (T07).** `compileQuery()` validates the JSON query (object, ≤ 100 fields or lookup paths, filter tree,
  ≤ 3 sort keys, limit ≤ the caller's max, cursor, `scope: 'recent'`) and resolves every reference through
  metadata as the caller: standard fields are columns, custom fields are casts out of `custom`, lookup paths
  (≤ 3 relationships) are LEFT JOINs whose target carries its own sharing predicate and `deleted_at IS NULL`.
  Hidden fields are dropped from the projection; in a filter or sort they are a `field_not_readable` error.
  Lookup fields come back as `{ id, name, object }`, with `name` null when the caller cannot see the target.
  Numbers, dates and timestamps are projected as text (exact decimals, `YYYY-MM-DD`, microsecond ISO), so cursors
  round-trip exactly. Keyset pagination orders `ASC NULLS LAST` / `DESC NULLS FIRST` (Postgres's defaults, so one
  index serves both directions) with the id last in the same direction; the cursor condition is an OR-chain that
  handles nulls. Counts stop at 100,001 ("100k+"). `$me` in a filter value means the caller.
- **Gaps left for later tasks (T07).** A queue-owned record's owner comes back without a name (the owner lookup
  joins users only; T19 shows queues). Statement timeouts are the caller's (`withTenant` options, 5 s interactive,
  60 s async per §3.8); EXPLAIN sampling of slow queries lands with the API in T12.
- **Verification waits for a chain run (fix during T07).** Verifying chained a tenant first but, if another run held
  the tenant's chain lock, went straight on, so rows committed a moment earlier showed as pending (an intermittent
  failure of the on-demand verify test under load). Verification now waits for the holder, then chains.
- **RecordService is a package (T08).** `@sm/records` holds the write pipeline so the API, the worker (mass
  actions, T10) and the seeds share one implementation (golden rule 2). Order per §3.7: object access (404 when the
  object is unknown or unreadable, 403 without create/edit) → record access through the sharing predicate (404 when
  invisible, 403 without edit; changing the owner needs Full access) → input check (unknown and read-only fields
  400, FLS 403 listing the fields, types via `normaliseValue`) → defaults (owner = writer, Master record type, field
  defaults, default picklist values; opportunity pipeline from the record type, else the default; first open
  stage) → stage rules (probability and forecast category from the stage unless given, `is_closed`/`is_won`, loss
  reason required when lost) → required fields and references (targets must exist, be live and readable by the
  writer; owners are active users or queues that take the object) → currency (active currencies only) → before-save
  and duplicate hooks (no-ops until P08/P03) → validation rules → corporate amounts → optimistic write
  (`version`, 409 with the current version) → stage history, field history → sharing rules for the record →
  audit (`record.created`/`record.updated`, field names only) and outbox events. Validation rules read related
  records in system context, as in Salesforce, and a rule that no longer type checks blocks the save.
- **Record events go to the `automation` queue (T08).** An outbox topic routes to one queue, and a queue with no
  consumer would grow in Valkey. `automation.record_created|updated|…`, `automation.owner_changed` and
  `automation.stage_changed` are acknowledged by the worker until flows, webhooks and AI signals consume them
  (P07/P08). Payloads hold the record id and changed field names, never values.
- **Leads (T08).** The converted status is set only by conversion; a converted lead is read-only (409
  `record_locked`) except to the conversion itself (T13).
- **Recycle bin (T09).** Delete needs the object's Delete permission and Full access to the record. A record the
  user cannot read is 404; one they can read but not fully control is 403. Deleting an account also deletes its
  contacts and opportunities (Salesforce semantics). Those child bin items point at the parent's item
  (`cascade_of`). Restoring a child alone is 409 `restore_parent`, and restoring the parent restores the children.
  Link rows (contact roles, relations, campaign members, teams) stay in place while their records are in the bin.
  They are removed when the records are purged.
  - Only the person who deleted a record, or someone with `modify_all_data`, can restore it. Everyone else gets 404.
  - Items are purged after 30 days by the daily `maintenance.recycle_purge` job, per tenant and in batches of 500.
    Purging deletes the rows and their shares, removes the link rows, and nulls lookups that pointed at the purged
    records.
  - A queue that still owns records, including records in the bin, cannot be deleted (409). Its records have to
    be transferred first.
  - A standalone bin page (list, restore, purge now) is left for the records API and UI (T12/T17). Deleted
    records' field history stays until its partition is dropped.
- **Bulk and mass actions (T10).**
  - **Bulk writes.** `bulkCreate`, `bulkUpdate` and `bulkDelete` take up to 200 rows. Each row runs in a savepoint
    through the full pipeline and gets its own result: `{index, ok, id, status, errors}`. A failing row rolls back
    alone; an error that is not a record error aborts the batch.
  - **Mass update** needs `mass_update`, and each row still needs edit access and field-level edit permission.
  - **Mass transfer** needs `transfer_records` plus Full access on each record, exactly what a single transfer
    needs. The permission unlocks the mass action; it grants no access beyond that (a conservative reading of
    §6.2). An account takes its contacts along, and, per `opportunities: none|open|all` (default `open`), the
    opportunities its previous owner held. Teams stay unless `keepTeams: false`.
  - **Mass delete** needs Modify All on the object and sends records to the recycle bin.
  - **Deferred.** "Transfer tasks" waits for activities in P03.
  - **Select all matching.** Selections of up to 10,000 records run as a job. `startMassAction` checks the
    permission, counts the matching records (the preview) and creates a `job_run` with kind `mass_<action>`. It
    then emits `import.mass_action`. The worker's `import` queue runs the job as the user who started it: rows
    are selected when the job runs, one transaction per batch of 200. Progress goes to `job_run.done`/`failed`,
    and the first 100 failures go to `job_run.result` (migration 0018, additive). A retried job starts over. Rows
    already done are no-ops or no longer match. A finished job is not run again.
  - **Shared context.** `loadRecordContext` in `@sm/records` builds a RecordContext from the database:
    permission source, org-wide defaults, principals, `$User`/`$Org` globals and the tenant's dated-rate currency
    converter. The worker uses it, and the records API will too (T12). `toGrants`/`loadPermissionSource` moved
    there from the API.
- **Sharing on CRM tables (T11).** `@sm/records/src/shares.ts` derives TEAM, IMPLICIT_PARENT and IMPLICIT_CHILD
  shares from the source rows. On each sync it deletes the shares it owns for the affected records and
  re-inserts what the sources say now, so these shares cannot drift. Rule, manual and territory shares are never
  touched here.
  - **Account team members** get their membership's access on the account. They also get their
    `opportunity_access` (0 none, 1 read, 2 edit) on the account's opportunities.
  - **Opportunity team members** get their membership's access on the opportunity.
  - **IMPLICIT_PARENT.** Owners (users or queues) of an account's live contacts and opportunities get Read on the
    account.
  - **IMPLICIT_CHILD.** The account owner gets Read on the account's opportunities. Contacts are CONTROLLED_BY_PARENT
    and follow the account already.
  - **When shares resync.** RecordService resyncs on create, and on owner or account changes. Delete and undelete
    resync too, so deleted records drop their derived shares. An account owner change also resyncs the account's
    opportunities.
  - **Teams.** `setTeamMember`, `removeTeamMember` and `listTeam` manage teams. Changing a team shares the record,
    so it needs Full access (§6.2); a record the user cannot read is 404. Every change is audited
    (`record.team_member_set` / `record.team_member_removed`, no values beyond the user id and access levels).
  - **Predicate.** The CONTROLLED_BY_PARENT lookup now filters the parent on `tenant_id` so it probes the
    `(tenant_id, id)` primary key.
  - **perf:sharing** now loads real `account` rows and a fifth as many `contact` rows (CONTROLLED_BY_PARENT) into
    the bank tenant. It measures list pages on both objects; results are below.
  - **Two decisions to confirm at the gate.** (1) Manual shares survive an owner change; Salesforce removes them.
    (2) Under CONTROLLED_BY_PARENT, a contact's own owner gets no access beyond what they have on the account,
    and implicit Read on the account is not enough to edit their own contact. §6.3 says contact access is
    "controlled by its primary account", and I have kept that literally. Salesforce gives record owners full
    access regardless.
  - **perf:sharing results (T11)**, bank tenant: 930 users, org depth 3, 500k accounts, 100k contacts and 25k shares.
    - Closure: 5,408 rows; a full rebuild takes 137 ms p50.
    - Principals: 7 ms computed, 0.3 ms from cache.
    - List pages of 50: the worst p95 is 108 ms (contacts, CONTROLLED_BY_PARENT, for a telesales agent who reaches
      2 owners). Accounts are at 48 ms or less. The §11.1 budget is 400 ms, so this passes.
- **Currencies and rates (T16).**
  - **API.** Setup → Currencies & rates lives under `/v1/currencies`. It lists currencies, adds and
    activates/deactivates them, and gets, puts and deletes dated rates. Reading needs `view_setup`; changes need
    `customize_application`. Every change goes to the setup audit.
  - **Corporate currency.** It is always active, cannot be deactivated (409) and never has rates (409).
  - **Rates.** A rate is a positive decimal string with up to 8 places, in units per one corporate unit. Rates
    are keyed by effective date. `PUT` creates a rate or corrects one, optimistically locked when a `version` is
    given.
  - **Deactivating a currency** keeps it on existing records; new writes are refused (`inactive_currency`, T08).
  - **RecordService** converts with the tenant's dated rates through `tenantCurrencyConverter` (T10). Rounding is
    half-up to 2 places; the same rule applies in SQL.
  - **Recalculation.** Changing or deleting a rate queues `maintenance.currency_recalc` with a `job_run`. The job
    recomputes only the amounts that rate governs, in batches of 1,000:
    - Opportunity amounts closing on or after the rate date and before the next rate date.
    - Other money converted with exactly that rate date, re-rated with the rate now in force on that date.
  - **Recalculation limits.** A rate added between two existing dates cannot move non-opportunity money: the day
    that money was set is not stored, only the rate date it used. Derived columns are rewritten without a version
    bump, history or per-record audit. The rate change itself is audited.
  - **Known gap.** Campaign money uses one `corporate_rate_date` for its three fields. If they are set on different
    days, only the last conversion's rate date is kept.
