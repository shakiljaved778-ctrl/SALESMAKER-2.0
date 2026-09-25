# P01 — task checklist

Tick each box when the task's commit is pushed with CI green. Details are in `P01-plan.md`.

- [x] **T01** `ci: coverage gates` — shared `coverage()` gate in `@sm/config/vitest` (80% lines; 90% for formula, permissions and query-engine, guarded by a test); every vitest workspace runs `--coverage`. Web gates the BFF (`src/server`); pages are covered by e2e.
- [x] **T02** `feat(metadata): standard object catalogue` — `@sm/metadata`: 10 standard objects, standard fields, OWD defaults, FLS scope; labels in `@sm/i18n` under `objects.*`. Open calls recorded in `P01-notes.md`.
- [ ] **T03** `feat(db): hierarchy schema`
- [ ] **T04** `feat(db): permission schema`
- [ ] **T05** `feat(permissions): permission engine`
- [ ] **T06** `feat(db): groups and queues`
- [ ] **T07** `feat(worker): outbox + worker app`
- [ ] **T08** `feat(sharing): OWD, closure and principals`
- [ ] **T09** `feat(sharing): shares, rules and predicate`
- [ ] **T10** `feat(access): AccessService + guards`
- [ ] **T11** `feat(audit): hash-chained audit log`
- [ ] **T12** `feat(auth): login history and sessions`
- [ ] **T13** `feat(users): users and invitations API`
- [ ] **T14** `feat(setup): hierarchy, permissions and sharing API`
- [ ] **T15** `test(permissions): permission matrix suite`
- [ ] **T16** `feat(db): identity seeds`
- [ ] **T17** `feat(web): Setup shell + Users`
- [ ] **T18** `feat(web): hierarchy and permissions pages`
- [ ] **T19** `feat(web): groups, queues and sharing pages`
- [ ] **T20** `feat(web): audit, login history, setup audit`
- [ ] **T21** `feat(web): personal settings`
- [ ] **T22** `perf(sharing): bank-scale check`
- [ ] **T23** `test(e2e): P01 journeys`
- [ ] **T24** `docs: P01 docs + handoff`
