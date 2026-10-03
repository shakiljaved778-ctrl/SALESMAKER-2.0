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
- **Records API (T12).** One generic controller, `apps/api/src/records`. Reads go through the Query Engine and
  writes through RecordService, both as the caller.
  - **Objects:** `GET /v1/objects` and `/describe`.
  - **Records:** CRUD on `/v1/records/{object}[/{id}]`, upsert at `PUT …/external/{externalId}` (the standard
    unique `external_id`), and `POST /v1/query` (SMQ).
  - **Mass actions:** `POST …/mass/preview` and `…/mass`, which returns a job; `GET /v1/jobs/{id}` shows only the
    caller's own jobs.
  - **Teams:** `GET|PUT|DELETE …/{id}/team[/{userId}]`.
  - **Recycle bin:** `GET /v1/recycle-bin` (your own items; everything with `modify_all_data`) and
    `POST …/{id}/restore`.
  - **Lists.** `?fields=a,b.c&sort=-amount,name&limit=50&cursor=…&filter[field][op]=v` maps to SMQ. Lists cap at
    200 rows; `/v1/query` allows up to 2000.
  - **Responses.** Every response carries `version`. Money is `{amount, currency}`, and Money is accepted on input
    (all money fields must share one currency).
  - **Concurrency.** `If-Match` gives optimistic concurrency (409 `version_conflict`). Without it, the last
    write wins.
  - **Idempotency-Key.** Optional on create. It is stored with the response in the same transaction for 24 h,
    scoped to the caller, and 422 `idempotency_key_reused` if the body differs. The daily purge job drops expired
    keys.
  - **Errors.** RecordService and Query Engine errors map to RFC 9457: not found → 404, forbidden → 403, invalid →
    400, unprocessable → 422, conflict → 409.
  - **Hidden fields.** A filter or sort on a field the caller cannot read is reported as `unknown_field`, exactly
    like a field that does not exist. A hidden field requested in `fields` is silently left out.
  - **Visibility.** These routes are `internal` in OpenAPI until API keys land (P03); then they become the
    published public API.
  - **Corporate amounts** (`*_corporate`) are not exposed yet; the record page needs them in T20.
  - **SMQ** gained an opt-in `recordMeta` that returns `version` and the record's `currencyCode`.
- **Lead conversion (T13).** `convertLead` / `undoConversion` in `@sm/records`; API at
  `POST /v1/leads/{id}/convert[/undo]` and Setup `GET|PUT /v1/leads/field-mapping`.
  - **One transaction.** Every record goes through RecordService as the caller, so permissions, FLS, validation
    rules, history and audit apply. Any failure rolls the whole conversion back.
  - **Account and contact.** Each is either an existing record the caller can see, or a new one built from the
    mapping and overridden by fields in the request. An existing contact must belong to that account or to none;
    one with no account joins it.
  - **Opportunity.** Optional. Its name defaults to the lead's company (the lead has no "product interest" field
    yet). Pipeline and stage come from the opportunity's own record type through RecordService; there is no
    lead-record-type mapping yet. The new contact becomes its primary contact role.
  - **Field mapping.** Defaults (company → account name, address → billing/mailing, person fields → contact,
    source/campaign → opportunity) can be overridden per target field by admin mappings (`lead_field_mapping`,
    migration 0019). Mappings are type-checked when saved:
    - the same type;
    - text-like into a long-enough text field;
    - a lookup to the same object.
      Saving needs `customize_application` and is audited.
  - **What gets copied.** Only fields the caller can read on the lead and edit on the target. A picklist value
    the target does not offer is skipped.
  - **The lead after conversion.** It takes a CONVERTED status and the `converted_*` system fields, set through a
    new conversion-only `system` write option. It is read-only from then on.
  - **Campaign memberships** are copied to the contact; the lead's memberships stay as history.
  - **Undo.** Possible within 24 h, for whoever converted or `modify_all_data`, if the lead and every record the
    conversion wrote still have the versions it left (`lead_conversion.record_versions`). It:
    - removes the created records for good (`hardDelete`, now shared with the purge);
    - removes the copied memberships;
    - takes back the account a contact joined;
    - restores the lead's status.
- **Search v1 (T14).** Migration 0020 adds the search indexes:
  - a weighted `search_vector` (A: names, email words, phone digits; B: company or title/department; C: other
    text), maintained by trigger on every write;
  - `pg_trgm` word-similarity indexes on name expressions, for typos;
  - reversed-digit phone indexes (`crm_phone_rev`), for suffix matching from 4 digits.
  - **Engine.** `search()` in `@sm/query-engine` matches prefix full text, trigram names and phone suffixes.
    Sharing is applied in SQL, and display values go through SMQ (sharing and FLS again).
  - **FLS.** A field the caller cannot read is never matched on: the readable part of the vector is rechecked,
    trigram matching is off if a name field is hidden, and hidden phones are not suffix-matched. Hidden fields are
    never reported in `matched`.
  - **`SEARCH_FIELDS`** mirrors the trigger, and a test proves they build identical vectors.
  - **API.** `GET /v1/search?q=&objects=&limit=&ownerId=&updatedSince=&totals=` returns results grouped by object
    (totals capped at 100 for facets). Recent items: `POST /v1/records/{object}/{id}/viewed` (keeps the latest 100
    per user) and `GET /v1/recent-items` (only records still visible).
  - **Deferred.** The p95 < 200 ms target at scale is measured in T28. The OpenSearch provider is P12.
- **Setup metadata API, fields (T15a).** `GET|POST /v1/setup/objects/{object}/fields`, `PATCH|DELETE …/{field}` and
  `PUT …/{field}/picklist-values`. Reading needs `view_setup`; changes need `customize_application`. Every change
  is in the setup audit, and the metadata version bump makes caches pick it up.
  - **Custom fields.** Stored as `<name>__c` in `custom` jsonb. Types: text, textarea, long text, email, phone, URL,
    number, currency, percent, date, datetime, checkbox, picklist, multi-picklist, lookup. Formula, roll-up and
    auto-number fields come later.
  - **Checks.** Per-type length, precision and scale rules (currency is always scale 2); picklists need values;
    lookups need a target; default values are validated against the saved field. Up to 500 custom fields per
    object. The 60 tracked-field limit is enforced by the database and reported as 409.
  - **API names never change.** Allowed type changes are only safe widenings (text → textarea → long text,
    longer text, more digits); scale is fixed.
  - **Standard fields** take only a label, description, help text and history tracking.
  - **Access.** New fields are granted to the System Administrator profile, plus any permission sets named in
    the request (FLS); the change bumps `permVersion`.
  - **Delete** is a soft delete of custom fields only. It is refused while a validation rule or path uses the
    field. It removes the field's FLS rows, index request and layout entries. Values stay invisible in records
    and the name is not reused.
  - **Picklists.** Values are written in order: known values are updated, new ones added, missing ones deactivated
    (never removed, because records keep them). One default at most; categories only for lead status; stages
    come from pipelines.
  - **Not offered for custom fields yet:** unique and external-id. Both need an index, so they wait on the
    index-build decision.
  - **Search** covers the fixed T14 field set, so the `searchable` flag is not settable yet.
  - **Indexed custom fields** (Q11) are recorded as PENDING `custom_field_index` rows, up to 10 per object. The
    builder is blocked on OPEN_QUESTIONS Q30: CONCURRENTLY cannot run inside a SECURITY DEFINER function. That is
    for the owner to decide.
  - **Cache safety.** Setup writes read metadata uncached inside the transaction (`freshMetadata`). A version
    that might roll back is never cached.
- **Setup metadata API, layouts and rules (T15b).** These live under `/v1/setup/objects/{object}/…`, with the same
  permissions and audit as T15a.
  - **Record types.** Create and update; there is no delete — deactivate instead. Options:
    - per-record-type picklist values, used by RecordService and describe;
    - an opportunity pipeline;
    - one default per object, which cannot be deactivated or unset.
  - **Page layouts.** Sections may name only the object's fields, each once. Related lists must be real child
    lookups with known columns. There is one default, which cannot be deleted; deleting another layout removes
    its assignments.
  - **Layout assignments.** Profile × record type → layout, replaced as a set, with references checked.
  - **Compact layouts.** 1–7 fields, one default.
  - **Paths.** Per record type and picklist, with steps that must be the picklist's values (stages for
    opportunities) and key fields of the object.
  - **Validation rules.** The formula must type check as Boolean against the object's metadata (prior values
    allowed); errors come back as `formula.<code>` with the span. RecordService enforces active rules at once,
    through the metadata version bump.
- **DataGrid (T17).** `@sm/ui` `DataGrid` is built on TanStack Table v8 and TanStack Virtual (MIT). v8 is the
  mature line; v9 changed its API.
  - **Columns:** sticky header and first column, plus user-pinned columns with logical (`inset-inline-*`)
    offsets. Resize by drag or keyboard (arrows on the focused handle). Reorder by dragging a header, or with
    the column menu (move left/right). Pin and hide from the column menu; required columns cannot be hidden.
  - **Sorting:** multi-sort with shift, ascending first. Sorting is client-side, or server-side when
    `onSortingChange` is given (keyset lists).
  - **Selection:** checkbox selection with shift-click ranges and Space.
  - **Rows:** row actions at the end edge on hover and focus; grouped rows with collapsible headers and
    aggregates; "Load more" for keyset paging.
  - **Keyboard:** ARIA `grid` with row and column indices and roving focus. Arrows, Home/End (Ctrl for corners),
    PageUp/Down; Enter sorts a header, toggles a group, edits an editable cell (`renderEditor`, Esc cancels) or
    opens the row; double-click also opens. Arrow keys mirror in RTL.
  - **States:** loading skeleton (`aria-busy`), empty vs no-results (`filtered`), error and no-permission. Copy
    comes from props; every label is a prop (`DataGridLabels`, golden rule 5).
  - **Virtualisation** starts above 100 items. The scroll area falls back to its intended height when it measures
    0 px.
  - **Bug found in the stories and fixed.** The grid's height now sits on its outer box. Before, the scroll area's
    `flex-1` beat its explicit height, so it grew to the full content height and the virtualiser rendered all rows.
  - **Direction** is inherited from the document unless `dir` is given; the effective direction is read from
    layout.
  - **Tests and stories.** 13 component tests. Four stories (default, grouped, 10,000 rows, states) pass axe in
    5 theme × density × direction variants, with visual baselines.
  - **Deferred.** Formatting values per field type (currency, relative dates, phone, lookup chips) is T18 (field
    renderers), which plugs into `column.cell`.

### T18 — record components (`@sm/ui`)

- **`FieldValue`** renders one value per field type. Money is formatted from its decimal string (`Intl` takes the
  string, so there is no float round trip). Percent values are the percentage itself (12.5 means 12.5%).
  Dates within 7 days are relative ("in 3 days", "15 min. ago") inside `<time>` with the absolute form as a
  tooltip; date-only values never shift with the viewer's zone, and "today" follows the viewer's calendar.
  Phone → `tel:`, email → `mailto:`, URL → new tab with `noopener noreferrer` and a screen-reader suffix.
  Lookups render as a `LookupChip` with an optional hover card (compact layout). Picklists are status chips;
  checkboxes are words plus an icon, never colour alone. Empty values show the `empty` label.
- **`FieldEditor`** edits one value per type and inherits `FormField` wiring. Number, percent and currency
  accept only a plain decimal draft (no grouping) and emit strings. Datetimes emit UTC ISO strings (the
  browser's zone is used for input; the user's profile zone arrives with T20/T21). Picklists have a `--None--`
  option; multi-picklists are a checkbox group labelled by the field and keep option order; lookups are an
  async combobox that keeps the current record listed and emits `{id, name, object}`.
- **`HighlightsPanel`**: object chip, name as `h1` (`title-2`), compact fields, owner avatar, follow slot, at most
  3 action buttons; the rest and every destructive action go to the overflow menu, destructive last.
- **`Path`**: chevrons via the `path-chevron` CSS utilities, mirrored under RTL. Completed = primary with a
  check, current = selected tint with brand text and `aria-current="step"`, future = muted; screen-reader
  state suffixes. Selecting a stage previews its key fields and guidance in a drawer; the action is "Mark
  stage as complete" (hidden on the last stage) or "Mark as current stage" for another selected stage.
- **`RecordForm` / `FormSection` / `FormSpan`**: 1–2 column sections as `fieldset`/`legend`, errors banner slot,
  sticky footer, submit without reload. `FormField`'s label now has an id (`<id>-label`) so groups can use it.
- **`RelatedList`**: header with icon, count (with an accessible count label), New; preview rows with up to four
  fields; View all; empty, loading, error and no-permission states.
- **Tests and stories.** 24 component tests; five stories pass axe in all 5 variants, with visual baselines.

### T19a — list views API

- `GET/POST /v1/objects/{object}/list-views`, `PATCH/DELETE …/{id}`, `PUT …/{id}/pin`, `POST …/{id}/results`.
- **Who may do what (decision).** Anyone who can read an object keeps private views. Sharing a view with
  public groups or everyone, and changing the views every object starts with (All, Mine, Recent), needs the
  existing `customize_application` permission. The spec names no list-view permission, so none was added
  (no permission-model change). Shared-view changes are setup-audited; private views are not.
- A view is compiled as its author when saved (unknown or unreadable fields, bad filters and sorts are 400s)
  and run as the viewer. Columns the viewer cannot read are dropped from the run, not refused, so a shared
  view keeps working for users with narrower FLS; `columns` in the result says what came back.
- Results: the view filter AND quick filters (`where`) AND a name-field `contains` search; sort and columns
  can be overridden per run; keyset paging; `count: true` adds the capped count. `recent` runs with SMQ
  `scope: 'recent'`.
- Pinned default per user: migration `0021_list_view_pin` (additive, RLS forced). Deleting a view drops pins.
- System views cannot be deleted (409) or made non-public (400). Other tenants' views are 404.

### T19b — object lists (T1)

- `/leads`, `/accounts`, `/contacts`, `/opportunities` (and `/campaigns`) render `ObjectList` from the
  `[section]` route; other sections keep their "on its way" page.
- **View picker** (pinned default marked; `?view=` in the URL), **more actions**: make default, save view
  (when the viewer may change it and has re-sorted or re-columned), save as new view (private, or public groups /
  everyone with customize_application), density, delete view.
- **Quick filters:** search (name field, debounced 250 ms), "My records" (`owner_id = $me`), and the first picklist
  column of the view (status, stage…). **Column chooser** (≤ 30, the name always shows), server-side sort from the
  headers (≤ 3, shift for multi), count ("12 items" / "100000+ items"), load more by keyset.
- **Inline edit** with E (Enter opens the record): text, numbers, money, dates, picklists, checkboxes; saved with
  `If-Match` (the BFF relay now forwards it); a 409 reloads the list with a toast. Lookups are not edited inline yet.
- **Bulk selection** with "select all N matching" (sends the combined filter as `where`), **mass update** of one
  field (needs mass_update) and **mass delete** (the server requires Modify All), previewed, run as a job and
  followed to the end.
- **Split view** shows the focused record's list columns beside the list; J/K move it.
- `@sm/ui` DataGrid gained `listKeys` (J/K/X/E, Enter opens) and `onActiveRowChange`.
- Fixed in passing: Radix Select's viewport `<style>` was refused by the CSP on every page with a Select; it now
  carries the request nonce (`get-nonce`, MIT, already in the tree).
- **Deferred:** mass transfer (change owner) needs a user picker for non-admins; it lands with the record page's
  owner change (T20). Record and create pages are T20/T21 (links point there).

### T20a — record page API

- `GET /v1/records/{object}/{id}/page`: the record with every field its layout, compact layout and path need;
  the caller's page layout (by profile × record type, else the default) with translated section headings and
  fields cut down by FLS; related lists; and the active path for the record type, its stages in picklist order
  with key fields (FLS-filtered) and guidance.
- **Related lists (decision).** A layout without related lists gets one per lookup pointing at the object
  (contacts and opportunities on an account, …), skipping owner/audit/record-type and `converted_*` lookups,
  with the child's name and compact fields as columns (≤ 4). `canCreate` says whether "New" may prefill the
  lookup. Admin-configured related lists win when present.
- `GET …/history`: tracked changes newest first, keyset-paged, with the changer's name. FLS masks history: changes
  to fields the caller cannot read are left out entirely. Both routes are 404 for records the caller cannot see.

### T20b — record pages (T2)

- `/{section}/{id}` renders `RecordPage`: Highlights Panel (object chip, name, compact fields, owner; Edit, and
  Delete with confirm → recycle bin with an Undo toast that restores), Path when the record type has an active
  path (mark complete / mark another stage current, saved with If-Match), and tabs Overview (page-layout sections
  with per-field inline edit, FLS- and layout-read-only aware), Related (preview of 5, count, "New" prefilled with
  the lookup — the create page is T21), History (FLS-masked, load more).
- Activity and AI tabs and the right rail arrive with their phases (P03/P07); they are not stubbed.
- Opening a record posts `…/viewed` (recent items) and registers a **workspace tab**: the shell's tab bar now lists
  open records for the browser session (≤ 10, sessionStorage, each closable).
- `@sm/ui` Path now follows `current` when it changes.

### T21 — create and edit

- `GET /v1/objects/{object}/layout?recordTypeId=` gives the caller's page layout for a new record (same
  profile × record type resolution and FLS cut as the record page; unknown record type → 404).
- `RecordEditor` serves three entry points: the list's **New** opens a **quick-create dialog** with the layout's
  required fields (and a link to the full form); `/{section}/new` is the **full-page create** (a record-type
  picker first when the object has several; `?field=value` prefills, e.g. a related list's New prefills the
  lookup with its name resolved); `/{section}/{id}/edit` is the **full-page edit** (read-only layout fields shown
  as values).
- Required fields are checked before sending; server errors are **field-keyed** (known codes have their own
  wording, validation rules show the admin's message, anything else "Check {field}"). Errors on fields not in the
  form go to the banner.
- Create sends one `Idempotency-Key` per form, so a retry never makes two records. Edit sends only changed
  fields with `If-Match`; a 409 opens a **conflict dialog** (reload their version, or keep editing to copy what
  was typed).
- **Unsaved changes**: Cancel asks to discard, and leaving the page triggers the browser's prompt.
- Lookups are edited with async search over the referenced objects; lookups to users (owner) and record types are
  not edited in the form (owner change and the record-type picker cover them). Picklist defaults start selected.

### T22 — convert dialog and account hierarchy

- **Convert** (lead record page action, hidden once converted): account = new (name prefilled from company) or an
  existing match from search (an exact name match starts selected, to avoid duplicates); contact = new or an
  existing contact with the lead's email (at the chosen account); optional opportunity with name and close date
  (default +30 days; close date is required on opportunities); converted status when there are several. On
  success it opens the opportunity (or account) with an **Undo** toast (8 s) calling `…/convert/undo`.
- **Hierarchy** tab on accounts: parents up to the root (≤ 10) and descendants (≤ 5 levels, 200 per level) via
  the Query Engine, as nested lists with disclosure buttons (axe-clean); the current account is marked
  `aria-current`. Accounts the viewer cannot see are absent, as everywhere.

### T23 — global search

- **⌘K Records**: typing searches `/v1/search` (debounced 150 ms; stale answers dropped) and shows the top 5 per
  object as sections, typo-tolerant ("aurelai" finds Aurelia), with icons and a secondary line (compact fields,
  picklists by label). Tab scopes to one object. "See all results" opens the results page. With an empty query,
  **Recent** records come first.
- `@sm/ui` CommandPalette sections can be `filtered`: items the caller already matched (remote search) keep their
  order and are never dropped by the client-side fuzzy filter; matching characters are still highlighted.
- **/search** page: query in the URL, facets for **object** (with totals from `totals=true`), **owner** (anyone /
  me) and **last updated** (any, 7 days, 30 days, year); 10 hits per object on "all", 50 for one object, with "Show
  all {objects}" links. Axe-clean.

### T24 — Object manager: fields

- Setup → **Customize → Object manager** (`/setup/objects`): every object (standard/custom). An object's page has
  **Fields** (label, API name, type, attributes: custom, required, history tracked, index pending) and **Record
  types** (create with a derived API name; make default; activate/deactivate).
- **New field wizard**: type → details (label → API name `<name>__c`, length / digits / decimal places, lookup
  target, picklist values one per line, help text, required, track history) → **field-level security** per profile
  (read/edit; System Administrator always) → **page layouts** (appended to the first section of each chosen layout,
  with the layout's version). Profiles now expose their own `permissionSetId` (additive) so FLS can be granted per
  profile at creation.
- **Field page** (`/setup/objects/{object}/fields/{field}`): label (standard fields fall back to the translated
  label), help text, description, required (custom only), history tracking; delete for custom fields (409 while a
  rule or path uses it). **Picklist values**: relabel, reorder, set default, deactivate, add; values are never
  removed.
- Reading needs view_setup; the controls appear only with customize_application (the API enforces both). All
  pages axe-clean.

### T25 — Object manager: layouts and rules

- Object page tabs: **Page layouts**, **Compact layouts**, **Path**, **Validation rules**, **Field history**.
- **Layout editor** (`/setup/objects/{object}/layouts/{id}`): rename; per section heading (standard headings
  translated), one or two columns, move up/down, remove when empty, add section; per field required / read-only,
  remove, move up/down and **move to another section with a picker** (the keyboard alternative to dragging, which
  also works between sections); add any unplaced field. Saved with the layout's version; unsaved changes guarded.
- **Compact layouts**: ordered pick of 1–7 fields. **Path**: per record type × picklist, active toggle, and per value
  up to 5 ordered key fields and guidance; remove path.
- **Validation rules**: list; create/edit dialog with a **formula editor that type-checks as you type** through the
  new `POST /v1/setup/objects/{object}/formula/check` (view_setup; nothing saved), showing the first error by code
  in words with its character position, and "valid" when the formula is Boolean; error message; where the error
  shows (top or a field); active.
- **Field history**: toggle history tracking for every trackable field at once.

### T26 — currencies and recycle bin

- **Setup → Customize → Currencies & rates**: the corporate currency (rate 1) and the others in use with today's rate;
  add a currency from the full ISO-4217 list (names from `Intl.DisplayNames`, searchable), activate/deactivate;
  per currency, dated rates newest first — add, change (with its version), remove — each answered with "being
  recalculated" (the API queues the corporate-amount recalculation). Rates are validated as positive decimals with
  up to 8 places before sending.
- **Recycle bin** (`/recycle-bin`, also a ⌘K command): the caller's deleted records (everything for Modify All Data
  users, as the API decides) with object, deleted and purge dates; Restore brings back the record and what was
  deleted with it (a child deleted with its parent says to restore the parent). Axe-clean.

### T27 — CRM demo data

- `pnpm db:seed --scenario=agency|bank --scale=demo|load` now fills the CRM after the workspace is activated
  (`apps/api/src/seed/crm.ts`). Volumes: agency 400 accounts / 900 contacts / 2,000 leads / 150 opportunities
  (both scales); bank demo 600 / 900 / 5,000 / 400; **bank load 60k / 90k / 500k leads / 40k** (the §11.1 scale).
- Everything is written through `RecordService.bulkCreate` (batches of 200) as a non-admin owner — no direct inserts,
  so validation, sharing rows, history and outbox behave exactly as for users. Generation is **deterministic**
  (mulberry32 seeded per scenario × object × index), so a re-run produces the same data and **resumes** from the
  rows already present; more than 1% rejected rows fails the seed.
- The bank scenario adds three opportunity record types (Retail banking, Corporate banking, Wealth management), each
  with its own stage pipeline. Closed-lost opportunities carry a loss reason; every opportunity has a type.
- Re-running against an existing workspace is idempotent: a 409 on reserve finds the tenant by slug, and a 409 on
  activation is accepted. `SEED_CONCURRENCY` (load scale defaults to 4) runs batches in parallel waves.
- Timing (local, one connection): bank demo ≈ 6,900 records in 1 min 45 s (≈ 65 rows/s); the load scale relies on
  concurrency and is measured in T28.

### T28 — scale check at 500k

**Seed.** `pnpm db:seed --scenario=bank --scale=load` wrote 60,000 accounts, 90,000 contacts, 500,000 leads and
40,000 opportunities through `RecordService.bulkCreate` in 70 min locally (4 vCPU): about 180 rows/s with 4
concurrent batches (one Node process is CPU-bound), about 38 rows/s for contacts and opportunities, which go one batch
at a time because each recomputes its account's implicit shares (concurrent batches deadlocked on them; a deadlocked
batch is now retried). Batch transactions get 120 s. The database is 2.7 GB (lead table 1.2 GB with indexes).
Docker's default 64 MB `/dev/shm` broke `VACUUM` at this size; compose now gives Postgres 512 MB.

**Budgets (§11.1), `pnpm --filter @sm/api perf:records`,** 60 sequential runs per row after 5 warm-ups, client-timed
through the API, as the busiest telesales agent (sees ~550 leads), a branch manager and the administrator:

| Operation                                                      |        p50 ms |          p95 ms | Budget |
| -------------------------------------------------------------- | ------------: | --------------: | -----: |
| Read lead (agent / admin)                                      |       20 / 18 |         25 / 24 |    120 |
| Update lead (agent)                                            |            30 |              36 |    250 |
| Create lead (agent)                                            |            29 |              41 |    250 |
| List "All leads", first page + count (agent / manager / admin) | 120 / 92 / 82 | 145 / 109 / 110 |    400 |
| List, status = working + count (agent / manager / admin)       | 18 / 35 / 177 |   22 / 46 / 228 |    400 |
| List sorted by last name (agent / manager / admin)             | 117 / 18 / 17 |   140 / 24 / 22 |    400 |
| List "My leads" + count (agent / manager / admin)              |  22 / 22 / 19 |    31 / 27 / 24 |    400 |
| Search a last name (agent / admin)                             |     106 / 162 |       126 / 186 |    200 |
| Search a company prefix (agent / admin)                        |     112 / 160 |       146 / 187 |    200 |
| Convert a lead (agent; no budget)                              |            91 |             319 |      — |

All budgeted operations pass. The script paces itself under the API's per-IP limit (20 requests/s); the wait is
not timed.

**What the first measurement found, and the fixes** (plans from `EXPLAIN (ANALYZE, BUFFERS)` as `sm_app` in the
tenant):

1. **The sharing predicate could not use an index.** `owner = me OR owner IN (closure) OR EXISTS (share)` made every
   list a sequential scan of all 500k rows: the agent's "All leads" count took 622 ms (547 visible rows). The owner
   and share arms are now arrays (`owner_id = ANY (…)`, `id = ANY (ARRAY(shared ids))`), which the planner combines
   with a BitmapOr on `(tenant_id, owner_id)` and the primary key: the same count takes 4–8 ms. Semantics are
   unchanged (the predicate suite passes, plus a test that the inlined form matches the subquery form for every user,
   object and level).
2. **The planner could not size the closure.** As a subquery it got the same row estimate for an agent (2 owners) as
   for a director (hundreds), so a status-filtered list walked the `last_name` index past 237,822 rows for 51 (513
   ms). API requests now read the closure once per request (`loadRecordContext({ inlineVisibility: true })`, one
   index lookup) and pass it as a value; Postgres estimates per owner and picks owner-index-then-sort for the agent
   (18 ms) and the sort index for wide viewers. Worker jobs and seeds keep the subquery, so a hierarchy change
   during a long job applies at once.
3. **JIT compiled OLTP statements.** Cost estimates that large made Postgres JIT-compile (301 ms of the 622 ms
   count). `withTenant` turns `jit` off per transaction.
4. **Search scored every row.** Under row-level security Postgres only evaluates leakproof functions before the
   tenant policy; `@@` (full text) and pg_trgm's `<%` are not leakproof, so neither GIN index can drive a scan for
   `sm_app` (as the superuser the same query uses `lead_search`). The trigram arm was OR-ed into every query and the
   index on the name expression matched all 500k candidates, so a search took 1.4–4.6 s. Full text now runs alone
   (a parallel scan, ~60–100 ms at 500k); typo matching runs only when nothing matched exactly in any object (plan
   §3.5, "did you mean"), tested.

**Known limits, for the owner (proposed Q31 below):**

- **Typo-only searches** (no exact match anywhere) take ~350 ms for an agent and ~1.2 s for an administrator at
  500k leads, and full-text search grows linearly with the tenant (≈ 10× at 5M). Both need the GIN indexes usable
  under RLS. Options: (a) mark `ts_match_vq` and the pg_trgm operators `LEAKPROOF` (superuser only; not available on
  RDS, so not portable); (b) a `SECURITY DEFINER` search function owned by a role with `BYPASSRLS` that filters on
  `tenant_id` itself — a change to the tenancy design (golden rule 1), so it needs your approval; (c) bring the
  OpenSearch provider forward from P12. Recommendation: (b), narrowly scoped to search candidate ids, with the
  sharing predicate and the display query still run as the user.
- **Concurrent bulk writes on shared parents** (imports that create many contacts under the same accounts) can
  deadlock on the derived implicit shares. Postgres resolves it by aborting one transaction; the seed retries.
  P03's import job should retry too, or the implicit-share sync should lock parents in id order.
- **The pg driver warns** about overlapping queries on one client: it comes from Prisma's query engine inside
  interactive transactions, not from our code (our two `Promise.all`s in transactions are now sequential). It must
  be resolved before pg 9.
- **Single-node numbers.** Measured on the development container (4 vCPU, Postgres in Docker), not on RDS; the
  nightly `scale` workflow re-measures on a GitHub runner.

### T29 — e2e P02 journeys

- `apps/web/e2e/records.spec.ts`, in every CI run:
  - **Create → edit → convert → search:** quick create from an empty list, the full form, conversion into an
    account, contact and opportunity, search finding them, and the account's related contact; axe on the list,
    quick create, record page (light and dark), convert dialog, search and account.
  - **Sharing, FLS, list views, inline edit:** an invited Standard User rep; leads private by default; a custom
    field created in the wizard with Standard User read turned off is absent from the rep's form, list columns,
    column chooser, record page and API response, while the administrator reads it; keyboard inline edit (focus a
    cell, E, Enter) saved and reloaded; a saved private view selected in the picker; the administrator's lead is
    "not available" to the rep and **404** from the API; search finds the rep's lead and not the private one; axe in
    dark mode.
- `apps/web/e2e/scale.spec.ts` (`E2E_SCALE=1`): a telesales agent of the bank seed at 500k leads signs in, opens the
  list (median **502 ms** to rendered rows over three client navigations, budget 800 ms), opens a lead and finds it by
  name. Green locally at the 500k seed, together with both journeys above.
- `.github/workflows/scale.yml`, nightly and on demand: seeds the bank at load scale, refreshes statistics, runs
  `perf:records` (fails over budget) and the scale journey.
- **Bugs the journeys found:** the new-record form loaded its layout twice and wiped what had been typed in between
  (fixed, T29 follow-up commit); toasts are mirrored in the live region, so tests match them exactly.
- **Session loss, more evidence for the grace window.** Under load, navigating away from a page while it performs
  its one session refresh lost the rotated cookie and signed the user out (seen in the journey before it waited for
  pages to settle). This is the P01 decision 1 risk, still waiting on your approval; the journeys now let each page
  finish its own requests before leaving it, and API checks reuse the app's access token instead of refreshing.

### Audit exception (end of P02)

- **GHSA-vfj7-8cjw-p6xm (`braces` ≤ 3.0.3, stack exhaustion on deeply nested patterns)** was published with no
  patched version and failed CI's `pnpm audit --audit-level high` on every branch. The only path is lint tooling:
  `@sm/config` → `eslint-plugin-boundaries` → `micromatch` → `braces`, which expands our own ESLint config globs,
  never input from users or the network, and is not in any runtime bundle. It is ignored by id in
  `package.json` (`pnpm.auditConfig.ignoreGhsas`); remove the entry when a fixed `braces` (or a `micromatch` without
  it) is published.
