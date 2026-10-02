# P02 — task checklist

Tick each box when the task's commit is pushed with CI green. Details are in `P02-plan.md`.

- [x] **T01** `feat(db): metadata schema` — migration 0015 (object and field definitions, picklist values, record types and their values, page layouts and assignments, compact layouts, path settings, validation rules, auto-number formats, list views; `metadata_version` triggers; `auto_number_next`); catalogue defaults in `@sm/metadata`; idempotent `syncStandardMetadata` at signup and in the seeds.
- [x] **T02** `feat(metadata): metadata service` — `loadTenantMetadata` (@sm/db), `MetadataCache` (LRU + Valkey by `metadataVersion`) and `MetadataIndex`, `normaliseValue` per field type (decimal.js), `MetadataService.forTenant` (syncs lagging tenants) and `describe` (FLS-filtered, localised labels, editable flags).
- [x] **T03** `feat(formula): parser and type checker` — new `@sm/formula`: lexer, Pratt parser with spans, type checker producing a typed AST (43 functions, cross-object paths through metadata, prior-value functions only where allowed), metadata environment; 217 tests, 99% lines.
- [x] **T04** `feat(formula): evaluator and SQL compiler` — evaluator (Decimal arithmetic, blank semantics, 43 functions, runtime errors with spans) and `compileToSql` for the filterable subset, proven equal to the evaluator on Postgres for 120 formulas plus 300 random ones; parser fuzz; 542 formula tests, 99% lines.
- [x] **T05** `feat(db): core CRM schema` — migration 0016: lead, account, contact, opportunity, campaign (catalogue columns, §4.1 columns, `custom`, money + corporate columns, search trigger, owner-leading sort indexes), pipeline and stages, account-contact relations, contact roles, append-only stage history, campaign members, lead conversions; default pipeline in the metadata sync.
- [x] **T06** `feat(db): record support tables` — migration 0017: monthly-partitioned append-only `field_history` (+ partition upkeep in the worker), `recycle_bin_item`, `recent_item`, `tenant_currency`, `currency_rate`, account and opportunity team members, `custom_field_index`.
- [x] **T07** `feat(query-engine): SMQ compiler` — `compileQuery`/`runQuery`/`countQuery`: metadata-resolved fields and ≤ 3-level lookup paths (each join shared), FLS projection and refusal in filters/sorts, custom fields out of `custom`, keyset pagination with nulls, recent scope, capped counts; filter compiler generalised to expressions and paths; 77 tests, 98% lines.
- [x] **T08** `feat(records): RecordService writes` — new `@sm/records`: create/update in §3.7 order (access, FLS, types, defaults, opportunity stage rules, required fields, references, currency, hooks, validation rules with cross-object values, corporate amounts, optimistic lock, stage and field history, sharing rules, audit, events); worker acknowledges `automation` record events; 14 tests, 95% lines.
- [x] **T09** `feat(records): delete, undelete, recycle bin`
- [x] **T10** `feat(records): bulk, mass update and transfer`
- [x] **T11** `feat(sharing): sharing on CRM tables`
- [x] **T12** `feat(api): records API`
- [x] **T13** `feat(leads): lead conversion`
- [x] **T14** `feat(search): search v1`
- [x] **T15** `feat(metadata): Setup metadata API` (custom-field index builder waits on Q30)
- [x] **T16** `feat(currency): currencies and rates`
- [x] **T17** `feat(ui): data grid`
- [x] **T18** `feat(ui): record components`
- [x] **T19** `feat(web): object lists (T1)`
- [x] **T20** `feat(web): record pages (T2)`
- [x] **T21** `feat(web): create and edit`
- [x] **T22** `feat(web): convert and account hierarchy`
- [x] **T23** `feat(web): global search`
- [ ] **T24** `feat(web): object manager — fields`
- [ ] **T25** `feat(web): object manager — layouts and rules`
- [ ] **T26** `feat(web): currencies and recycle bin`
- [ ] **T27** `feat(seed): CRM demo data`
- [ ] **T28** `perf(records): scale check at 500k`
- [ ] **T29** `test(e2e): P02 journeys`
- [ ] **T30** `docs: P02 docs + handoff`
