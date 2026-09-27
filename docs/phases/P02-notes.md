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
