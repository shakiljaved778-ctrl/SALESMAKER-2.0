# P01 handoff: identity, hierarchy and permissions

Plan: [P01-plan.md](P01-plan.md) · Tasks: [P01-tasks.md](P01-tasks.md) (24/24) · Decisions, deviations and
follow-ups: [P01-notes.md](P01-notes.md) · Branch: `claude/great-heisenberg-pbhzs3` (one Conventional Commit per task)

## Exit gate

| Gate                                                            | Evidence                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Permission matrix suite (≥ 150 cases) green (§14)               | `apps/api/test/permission-matrix.test.ts`: **310 cases** (profiles, permission sets, muting, OWD, hierarchy, groups, queues, owner- and criteria-based rules, manual shares, Controlled by Parent), expectations from an oracle written from §6.3 alone. Green in CI.            |
| Invite a teammate, place them, they see exactly what is allowed | `apps/web/e2e/access.spec.ts`: invite → accept → Setup hidden, "Setup is for administrators" and **403** from the API; the admin changes the profile and access follows on the next load (API **200**). Record-level visibility is covered by the matrix until P02 adds records. |
| The audit chain verifies                                        | Same journey: `audit:verify` chains and verifies the organisation's log (`status OK, pending 0`) and Setup → Audit log shows "Chain verified … no problems". Tamper cases (edited row, row in a declared gap, broken batch link) in `packages/db` and `apps/worker` tests.       |
| CI green on every job                                           | Latest runs: lint · typecheck · unit (coverage gates), db (migrate, rls-audit with every new table, drift), both e2e shards, Storybook axe, gitleaks, Terraform.                                                                                                                 |
| Coverage gates                                                  | Wired in T01. `@sm/permissions` 100% lines, `@sm/query-engine` 100%; every other package ≥ 80% (api 94.8%, db 92.2%, worker 94.3%, web BFF 94.9%).                                                                                                                               |
| Bank-scale numbers recorded (T22)                               | Worst 50-row list p95 **38 ms** against the 400 ms budget; closure 5,408 rows, full rebuild 134 ms; principal set 9 ms computed, 0.5 ms cached. Table in [P01-notes](P01-notes.md); rerun with `pnpm --filter @sm/api perf:sharing`.                                             |

## What was built

- **Hierarchy.** Unlimited-depth org units with a trigger-maintained closure table and cycle-safe moves; users gain
  org unit, manager (cycle-checked), profile, title, department, phone and deactivation.
- **Permissions.** Profiles (each owning a `PROFILE` permission set), additive permission sets, permission set
  groups with muting sets; system, object and field grants; one engine (`@sm/permissions`) and a Valkey cache keyed
  by `permVersion`, which triggers bump on every relevant change. See [permissions](../modules/permissions.md).
- **Sharing core.** Org-wide defaults, owner-visibility closure, groups and queues (nested, transitive), owner- and
  criteria-based rules with batched recalculation and progress, manual shares, `record_share` partitioned by
  object, cached principal sets, and `sharingPredicate()` for P02's Query Engine; `AccessService` with
  404-vs-403 semantics and "why can I see this?". See [sharing](../modules/sharing.md).
- **Jobs.** Transactional outbox (daily partitions, 7-day retention) and `apps/worker` on open-source BullMQ with
  in-house per-tenant fairness, retries and a dead-letter queue.
- **Governance.** Hash-chained `audit_log` (sequence-then-chain batcher, Merkle roots, gap declaration, daily and
  on-demand verification), `setup_audit` with before/after, `login_history`, session list and immediate remote
  sign-out. See [audit](../modules/audit.md) and the [audit-chain runbook](../runbooks/audit-chain.md).
- **Users and invitations.** Invite, resend, withdraw, accept (password or Google/Microsoft), deactivate/reactivate,
  assignments; SSO links only to invited or existing users.
- **Setup API and UI.** Users, org hierarchy, profiles, permission sets and groups, public groups, queues, sharing
  settings and rules, audit log, login history and setup audit trail, on the T5 Setup template with keyboard paths
  and every state designed. Accept invite. Personal settings: profile, display, password, two-step verification
  (in-page QR, new recovery codes, turn off), sessions.
- **Demo seeds.** `pnpm db:seed --scenario=agency|bank|all`: Pixelcraft (6 users) and Aurelia Bank (930 users:
  company → 4 regions → 20 branches → 80 teams, plus a telesales hub and compliance).
- **Docs.** [ERD](../spec/ERD.md) (three new diagrams), module docs for permissions, sharing and audit, the
  audit-chain runbook, and an ADR-0002 addendum (BullMQ 6.3.9, ioredis 6.0.0, uqr 0.1.2, all MIT).

## Tests

1,095 unit and integration tests (api 504, ui 165, db 88, web 70, query-engine 68, permissions 31, worker 30,
server-kit 29, config 22, control-api 21, testing 17, contracts 11, integrations 11, metadata 11, i18n 7, ai 6,
emails 4), Storybook axe on every story, and 10 end-to-end journeys (3 new in P01, axe on every screen in light and
dark, new visual baselines for the Setup template). Every new endpoint has happy-path, validation, permission and
cross-tenant (404) tests.

## Found and fixed late in the phase

- **Session refreshes (T23).** Settings pages called the API before the page restored its session, so one page load
  could rotate the single-use refresh cookie several times, and a navigation mid-rotation ended the session through
  reuse detection. The client now refreshes exactly once per page load (`test/cell-api.test.ts`).
- **Accessibility (T23).** Filter and member pickers without accessible names; settings pages without an `h1`.

## Decisions for the owner

1. **Refresh-token grace window.** A navigation during the one refresh a page load makes can still lose the rotated
   cookie and sign the user out. Proposal: accept the immediately previous token for ~30 s after rotation and
   return the same successor, still revoking the family on any other reuse. It changes the session security design,
   so it waits for your approval (it was already on the P00 security-review list).
2. **Open questions** still pending: Q1, Q6, Q9, Q11–Q14, Q16–Q19, Q21–Q29 in `docs/spec/OPEN_QUESTIONS.md` (Q10,
   Q15 and Q20 were answered at plan approval). **Q13 (corporate-currency conversion date) blocks the P02 plan.**
   Q27–Q29 are the locked tokens that miss the contrast rule.

## Carried into P02

- **Queue-owned records:** deleting a queue must be refused once it can own records.
- **FLS in audit payloads:** mask fields the viewer cannot read before record changes are audited (§6.5).
- **List indexes:** the slowest T22 case is a rep sorting a large table by name (few matches); add owner-leading
  indexes per sortable field for list views, and rerun `perf:sharing` against real object tables.
- **Standard object tables:** sharing rules on standard objects recalculate over 0 records until P02 creates the
  tables; the matrix runs on fixture tables with the §4.1 columns.
- **Dev-server CSP warnings:** `next dev` logs inline-style CSP violations on every page, including the P00 sign-in
  page; production builds do not. Worth a look when the CSP is next touched.
- **Staging-only demo users** (`demo+…@salesmaker.app`) and "Reset demo" belong to the staging deployment work.

## For P02

Re-read CLAUDE.md, §3.7–§3.8 (RecordService, Query Engine), §4 (data model), §6.5 (FLS), ADR-0004 and ADR-0007, this
handoff and P01-notes.md, then write `P02-plan.md` and stop for approval.
