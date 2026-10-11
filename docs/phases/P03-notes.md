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
