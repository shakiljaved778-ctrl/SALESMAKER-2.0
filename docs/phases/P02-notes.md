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
