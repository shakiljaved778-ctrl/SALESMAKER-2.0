# P01 — task checklist

Tick each box when the task's commit is pushed with CI green. Details are in `P01-plan.md`.

- [x] **T01** `ci: coverage gates` — shared `coverage()` gate in `@sm/config/vitest` (80% lines; 90% for formula, permissions and query-engine, guarded by a test); every vitest workspace runs `--coverage`. Web gates the BFF (`src/server`); pages are covered by e2e.
- [x] **T02** `feat(metadata): standard object catalogue` — `@sm/metadata`: 10 standard objects, standard fields, OWD defaults, FLS scope; labels in `@sm/i18n` under `objects.*`. Open calls recorded in `P01-notes.md`.
- [x] **T03** `feat(db): hierarchy schema` — `org_unit` + trigger-maintained `org_unit_closure` (cycle-checked moves, per-tenant advisory lock, sm_app read-only), `user.org_unit_id`, `manager_id` (cycle trigger), title, department, phone, `deactivated_at`.
- [x] **T04** `feat(db): permission schema` — migration 0006 (profiles own a PROFILE set; STANDARD and MUTING sets; groups; assignments; system/object/field grants with dependency checks; kind triggers; `perm_version` bumps), `@sm/permissions` catalogue and default profiles, provisioned at signup.
- [x] **T05** `feat(permissions): permission engine` — pure engine in `@sm/permissions` (union, per-group muting with downward closure, data-wide overrides, FLS with system/required-field rules), `PermissionCache` keyed by `permVersion`, `PermissionService` in the API; 100% line coverage.
- [x] **T06** `feat(db): groups and queues` — migration 0007: `public_group`, `group_member`, `queue`, `queue_member`, `queue_object`; typed members (user, group, org unit, org unit + subordinates) with a cycle trigger; SQL expansion functions wrapped by `membership` in `@sm/db`.
- [x] **T07** `feat(worker): outbox + worker app` — migration 0008 (daily-partitioned `outbox_event`, NOTIFY, owner-run partition maintenance); `outbox` API in `@sm/db`; `apps/worker` (relay via LISTEN + control-plane sweep, fair per-tenant priorities, retries, dead-letter queue, hourly maintenance); `GET /cp/v1/cells/self/tenants`.
- [x] **T08** `feat(sharing): OWD, closure and principals` — migration 0009 (`org_wide_default`, `user_visibility_closure` written only by `rebuild_user_visibility()`), `visibility` and `principalsOf` in `@sm/db`, `SharingService` (OWD resolution, principals cached by `permVersion`), signup provisioning, worker `sharing.visibility_changed` jobs.
- [x] **T09** `feat(sharing): shares, rules and predicate` — migration 0010 (`record_share` LIST-partitioned by object, `sharing_rule`, `job_run`); `@sm/query-engine` (filter tree, §6.4 `sharingPredicate` incl. CONTROLLED_BY_PARENT, manual shares, per-record rule evaluation, batched recalculation); worker `sharing.rule_changed` / `rule_deleted` jobs with progress.
- [x] **T10** `feat(access): AccessService + guards` — ordered §6.2 check (object → record → field), 404 vs 403, `@RequireSystemPermission` + `SystemPermissionGuard`, `describe()` and `GET /v1/me/access/{object}/{id}` ("Why can I see this?").
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
