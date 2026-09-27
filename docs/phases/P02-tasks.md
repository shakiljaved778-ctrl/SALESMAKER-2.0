# P02 — task checklist

Tick each box when the task's commit is pushed with CI green. Details are in `P02-plan.md`.

- [x] **T01** `feat(db): metadata schema` — migration 0015 (object and field definitions, picklist values, record types and their values, page layouts and assignments, compact layouts, path settings, validation rules, auto-number formats, list views; `metadata_version` triggers; `auto_number_next`); catalogue defaults in `@sm/metadata`; idempotent `syncStandardMetadata` at signup and in the seeds.
- [ ] **T02** `feat(metadata): metadata service`
- [ ] **T03** `feat(formula): parser and type checker`
- [ ] **T04** `feat(formula): evaluator and SQL compiler`
- [ ] **T05** `feat(db): core CRM schema`
- [ ] **T06** `feat(db): record support tables`
- [ ] **T07** `feat(query-engine): SMQ compiler`
- [ ] **T08** `feat(records): RecordService writes`
- [ ] **T09** `feat(records): delete, undelete, recycle bin`
- [ ] **T10** `feat(records): bulk, mass update and transfer`
- [ ] **T11** `feat(sharing): sharing on CRM tables`
- [ ] **T12** `feat(api): records API`
- [ ] **T13** `feat(leads): lead conversion`
- [ ] **T14** `feat(search): search v1`
- [ ] **T15** `feat(metadata): Setup metadata API`
- [ ] **T16** `feat(currency): currencies and rates`
- [ ] **T17** `feat(ui): data grid`
- [ ] **T18** `feat(ui): record components`
- [ ] **T19** `feat(web): object lists (T1)`
- [ ] **T20** `feat(web): record pages (T2)`
- [ ] **T21** `feat(web): create and edit`
- [ ] **T22** `feat(web): convert and account hierarchy`
- [ ] **T23** `feat(web): global search`
- [ ] **T24** `feat(web): object manager — fields`
- [ ] **T25** `feat(web): object manager — layouts and rules`
- [ ] **T26** `feat(web): currencies and recycle bin`
- [ ] **T27** `feat(seed): CRM demo data`
- [ ] **T28** `perf(records): scale check at 500k`
- [ ] **T29** `test(e2e): P02 journeys`
- [ ] **T30** `docs: P02 docs + handoff`
