# Metadata

Spec: §4, §5 · ADR: 0004, 0030 · Code: `packages/metadata`, `packages/db/src/metadata.ts`,
`apps/api/src/metadata`, `apps/web/src/components/setup/objects` · Tables:
[ERD](../spec/ERD.md#metadata-p02)

Metadata describes every CRM object: its fields, picklist values, record types, page and compact layouts, paths,
validation rules, auto-numbers and list views. RecordService, the Query Engine, search, the records API and the UI
all read it; nothing hard-codes a field list.

## The catalogue and the tenant copy

- **Standard catalogue** (`packages/metadata/src/catalogue.ts`): lead, account, contact, opportunity and campaign
  with their standard fields (typed columns on the object tables), picklist sets, the default pipeline and the
  record-number formats. `CATALOGUE_VERSION` moves when the catalogue grows.
- **Sync, not migration.** `syncStandardMetadata()` inserts whatever a tenant lacks (objects, fields, values, a
  Master record type, default layouts, system list views) and records `tenant_settings.catalogue_version`. It runs
  at signup, in the seeds, and lazily for any tenant behind the catalogue. It only inserts, so admin renames and
  extra values survive.
- **Custom fields** live in each record's `custom jsonb` under `<name>__c`; standard fields are columns. API names
  never change. Labels of standard items come from i18n until an admin renames them.

## Runtime

- `loadTenantMetadata()` (`@sm/db`) reads every metadata table, one query after another in the caller's
  transaction, into plain JSON (`TenantMetadata`).
- `MetadataCache` keeps it in process (LRU, 500 tenants) and in Valkey under `meta:{tenant}:{metadataVersion}`.
  Every Setup change bumps `metadataVersion` in the same transaction, so caches can never serve a rolled-back
  version: Setup writes read metadata uncached (`freshMetadata`).
- `MetadataIndex` answers the lookups: a field, the name fields, the layout a profile × record type sees,
  record-type picklist values, the path of a record type.

## Field values

`normaliseValue()` is the one check for a value written to a field (§5.3): text lengths, e-mail, phone (4–20
digits), URLs, numbers and money as decimal strings rounded half-up to scale, real calendar dates, UTC date-times,
active picklist values (per record type). Computed and system fields refuse writes. Money is never a float
(decimal.js).

## Setup

`/v1/setup/objects/{object}/…` (reading needs `view_setup`, changes `customize_application`; every change in the
setup audit):

- **Fields:** create custom fields (15 types), edit labels, help text, required, history tracking; picklist values
  are relabelled, reordered, defaulted, deactivated, added, never removed. Allowed type changes only widen. New
  fields are granted to System Administrator plus the permission sets chosen in the wizard.
- **Record types** (no delete: deactivate), **page layouts** and their assignments, **compact layouts** (1–7
  fields), **paths** (per record type and picklist, key fields and guidance), **validation rules** (formulas
  type-checked as Boolean; `POST …/formula/check` checks without saving), **field history** (≤ 60 tracked).
- **Indexed custom fields** (Q11) are recorded as pending `custom_field_index` rows; building them waits on
  ADR-0030 (Q30).

The web Object manager (Setup → Customize → Objects) covers all of it: the new-field wizard (type → details →
field-level security → layouts), the layout editor (sections, columns, fields moved by drag or by keyboard), paths,
rules with a live formula check, and field history.

## Tests

`packages/metadata/test`, `packages/db/test/metadata.test.ts`, `apps/api/test/standard-metadata.test.ts`,
`metadata-service.test.ts`, `field-setup.test.ts` and `layout-setup.test.ts`, and the new-field wizard in
`apps/web/e2e/records.spec.ts`.
