# P01 — Identity, hierarchy and permissions: plan

Status: **DRAFT, awaiting owner approval** · Weeks 2–3 · Spec: §6, §3.7–§3.10, §4.2 (Identity, Hierarchy and access,
Governance), §9.15 (Setup, Personal settings, Accept invite), §13.3 · ADRs: 0001, 0005, 0006, 0007, 0008 · Previous:
[P00-handoff.md](P00-handoff.md)

**Exit gate (§14):** the permission matrix test suite (≥ 150 cases) is green. The plan adds: an admin can invite a
teammate, place them in the hierarchy with a profile, and the teammate sees exactly what the model allows; the audit
chain verifies; CI is green on every job.

## 0. Assumptions pending owner answers

These questions touch P01. I will proceed on the proposed answers unless you say otherwise when approving this plan.

| Q   | Assumed answer                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10  | `CONTROLLED_BY_PARENT` for Contact: the **primary** account (the `account_id` on the contact) controls access; contacts with no account fall back to owner + hierarchy. Built generically in P01 (a "parent resolver" per object); it takes effect when Contact exists (P02).                                                                                                                                                                                        |
| 15  | Hash-chained `audit_log` uses the **sequence-then-chain batcher** that ADR-0008 already names as an option (details in §3.3), not a per-tenant lock. Every audited write inserts its entry in the same transaction; a chaining job hashes entries into the per-tenant chain within ~1 s and records a Merkle root per batch. Same tamper evidence, no per-tenant write serialisation, so bulk imports keep their throughput. This is within ADR-0008, so no new ADR. |
| 20  | Opportunity OWD defaults to `PRIVATE`; account-team membership (P02) extends access. `CONTROLLED_BY_PARENT` stays available per tenant.                                                                                                                                                                                                                                                                                                                              |
| —   | **Objects before metadata.** Object and field permissions need object and field names before the metadata engine exists (P02). P01 adds `@sm/metadata` with a static catalogue of the standard objects and their standard fields (Lead, Account, Contact, Opportunity, Campaign, Activity, Product and so on). Permissions reference them by API name, and P02 seeds `object_definition` / `field_definition` from the same catalogue, so nothing is renamed later.  |
| —   | **Coverage gates first.** The §13.3 thresholds (≥ 90% on `permissions`, ≥ 80% overall) are wired as T01, so everything P01 adds is measured from day one (P00 handoff gap).                                                                                                                                                                                                                                                                                          |

## 1. Scope

**In:**

- Users: invite, accept, deactivate/reactivate, profile/org unit/manager changes, permission-set assignment; SSO
  just-in-time linking only for **invited** users (§6.1).
- Org hierarchy: unlimited-depth `org_unit` tree with a closure table, `user.org_unit_id`, `user.manager_id`, cycle-safe
  moves.
- Permissions (§6.2): profiles, **additive** permission sets, permission set groups with an optional **muting set**,
  system / object / field permissions; one permission engine (`@sm/permissions`) and one effective-permission cache
  keyed by `permVersion`.
- Sharing engine core (§6.3–§6.4): OWD per object, hierarchy access, public groups (nested), queues, owner- and
  criteria-based sharing rules, manual shares, `record_share` partitioned by object, `user_visibility_closure`,
  cached principal sets, and the **sharing predicate** that the P02 Query Engine injects.
- Access decisions: `AccessService` evaluating tenant → system → object → record → FLS, used by P02's RecordService and
  Query Engine; a Nest guard for system permissions on every endpoint.
- Governance: `audit_log` (append-only, hash-chained, partitioned monthly) with a verifier, `setup_audit` (before/after
  diffs), `login_history`, session list and remote sign-out.
- Jobs: `apps/worker` (BullMQ) and the transactional `outbox_event` + relay (§3.9), because sharing recalculation and
  audit chaining depend on them. RecordService itself arrives in P02.
- Seeds: the identity half of both demo tenants (§15): Pixelcraft (6 users) and Aurelia Bank (800 reps: Company →
  4 Regions → 20 Branches → 80 Teams + a telesales hub, 7 profiles). Records come with P02+.
- UI: the Setup shell (T5) and the P01 Setup pages, Accept invite, and Personal settings (Profile, Display, Security).

**Out (later phases):** CRM objects, the Query Engine and RecordService (P02); field history (P02, with RecordService);
account/opportunity teams (P02); territories (P10); login IP ranges, login hours, MFA enforcement per profile, session
timeout policy UI (P12 Security, the columns are added now); passkeys (P12); API keys (P03); SAML/SCIM (P12).

## 2. Task breakdown

One Conventional Commit per task on the session branch, as in P00. Sequence at the end.

| #   | Task (commit scope)                                   | Contents                                                                                                                                                                                                                                                                                                                                                              |
| --- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T01 | `ci: coverage gates`                                  | `vitest --coverage` (v8) in every package; thresholds: 90% lines for `@sm/permissions` (and later `formula`, `query-engine`), 80% for other packages; CI fails below.                                                                                                                                                                                                 |
| T02 | `feat(metadata): standard object catalogue`           | `packages/metadata`: standard objects, their standard fields (API name, type, system/required flags) and OWD defaults (§6.3). Read-only, typed, tested.                                                                                                                                                                                                               |
| T03 | `feat(db): hierarchy schema`                          | `org_unit` + `org_unit_closure` (maintained in the same transaction by SQL functions; move = delete/insert subtree paths, cycle check), `user.org_unit_id`, `user.manager_id` (cycle check), user profile fields (title, phone, department, timezone, locale already exist), `user.deactivated_at`. RLS forced on all.                                                |
| T04 | `feat(db): permission schema`                         | `profile`, `permission_set`, `permission_set_group`, `permission_set_group_member`, `permission_assignment`, `system_permission`, `object_permission`, `field_permission`; default profiles created at signup (System Administrator, Standard User, Read Only); `tenant_settings.perm_version` bumps.                                                                 |
| T05 | `feat(permissions): permission engine`                | `packages/permissions`: pure functions computing effective permissions (profile ∪ sets ∪ group sets − muting set; View All ⇒ Read; Modify All ⇒ all; most-permissive FLS; system-field rules). Valkey cache per user keyed by `permVersion`. ≥ 90% coverage.                                                                                                          |
| T06 | `feat(db): groups and queues`                         | `public_group`, `group_member` (users, groups, org units, org units + subordinates), `queue`, `queue_member`, `queue_object`; transitive membership expansion with cycle protection.                                                                                                                                                                                  |
| T07 | `feat(worker): outbox + worker app`                   | `outbox_event` (partitioned daily, 7-day retention) written in the caller's transaction; `apps/worker` (BullMQ, per-tenant fairness keys, retries, dead-letter queue); relay with `FOR UPDATE SKIP LOCKED` + `LISTEN/NOTIFY`.                                                                                                                                         |
| T08 | `feat(sharing): OWD, closure and principals`          | `org_wide_default`, `user_visibility_closure` (sync for ownership, incremental `sharing` jobs for org-unit, manager and queue changes), `principals(user)` cached by `permVersion`.                                                                                                                                                                                   |
| T09 | `feat(sharing): shares, rules and predicate`          | `record_share` (LIST-partitioned by object, reasons per §6.4), `sharing_rule` (owner- and criteria-based; criteria evaluated with a filter-tree evaluator shared with P02), manual share / unshare, batched rule recalculation with progress, and `sharingPredicate(ctx, object, access)` returning a Kysely expression. `CONTROLLED_BY_PARENT` via parent resolvers. |
| T10 | `feat(access): AccessService + guards`                | The ordered layer check (§6.2), `requireSystemPermission()` Nest guard, and a `describeAccess()` explanation used by "Why can I see this?".                                                                                                                                                                                                                           |
| T11 | `feat(audit): hash-chained audit log`                 | `audit_log` (partitioned monthly; INSERT-only for `sm_app`), the chaining job and batch Merkle roots (§3.3), the verifier job and API, `setup_audit` (before/after JSON diffs) for every Setup change.                                                                                                                                                                |
| T12 | `feat(auth): login history and sessions`              | `login_history` for every sign-in outcome (password, SSO, MFA, lockout), session list and remote sign-out, "sign out everywhere". Invitation-only SSO linking.                                                                                                                                                                                                        |
| T13 | `feat(users): users and invitations API`              | List/search, invite (email via `EmailSender`, 7-day single-use token), resend/revoke, accept (password or Google/Microsoft), deactivate/reactivate (revokes sessions), change profile/org unit/manager, assign permission sets and groups.                                                                                                                            |
| T14 | `feat(setup): hierarchy, permissions and sharing API` | CRUD for org units (move), profiles, permission sets/groups, public groups, queues, OWD and sharing rules; each change bumps `permVersion` / enqueues recalculation and writes `setup_audit`.                                                                                                                                                                         |
| T15 | `test(permissions): permission matrix suite`          | The exit-gate suite: ≥ 150 table-driven cases over a fixture object table and `makeTenantWithHierarchy({ depth, usersPerUnit })`, covering every layer, OWD, hierarchy, groups, queues, rules, manual shares, muting and FLS read/edit, asserting both `AccessService` decisions and the rows the sharing predicate returns.                                          |
| T16 | `feat(db): identity seeds`                            | `pnpm db:seed --scenario=agency                                                                                                                                                                                                                                                                                                                                       | bank`: deterministic users, hierarchy, profiles, permission sets, groups and queues for both demo tenants (§15). |
| T17 | `feat(web): Setup shell + Users`                      | T5 Setup layout (searchable, deep-linkable tree), Users list/detail/invite/deactivate, Accept invite (replaces the P00 placeholder). Setup is hidden without `view_setup`; 403 otherwise.                                                                                                                                                                             |
| T18 | `feat(web): hierarchy and permissions pages`          | Org hierarchy tree editor (keyboard-accessible move), Profiles and Permission sets & groups (system permissions, object permission matrix, FLS matrix per object).                                                                                                                                                                                                    |
| T19 | `feat(web): groups, queues and sharing pages`         | Public groups, Queues, OWD & sharing rules (with recalculation progress and the < 60 s convergence note, ADR-0007).                                                                                                                                                                                                                                                   |
| T20 | `feat(web): audit, login history, setup audit`        | Viewers with filters and cursor paging, plus chain verification status.                                                                                                                                                                                                                                                                                               |
| T21 | `feat(web): personal settings`                        | Profile, Display (theme, density, locale, timezone), Security (change password, MFA enrol/disable with recovery codes, sessions).                                                                                                                                                                                                                                     |
| T22 | `perf(sharing): bank-scale check`                     | At the 800-rep seed plus a 500k-row fixture table: closure size and rebuild time, principal-set cache hit path, and the sharing predicate within the §11.1 list budget (≤ 400 ms p95 for 50 rows).                                                                                                                                                                    |
| T23 | `test(e2e): P01 journeys`                             | Invite → accept → constrained sign-in (Setup hidden, 403 on direct URL); admin changes profile / hierarchy and access follows; audit chain verifies; light + dark with axe.                                                                                                                                                                                           |
| T24 | `docs: P01 docs + handoff`                            | ERD update, `docs/modules/{permissions,sharing,audit}.md`, runbook for audit-chain verification, `P01-handoff.md`, ROADMAP.                                                                                                                                                                                                                                           |

**Sequence:** T01 → T02 → (T03, T04, T06, T07 in parallel) → T05 → T08 → T09 → T10 → (T11, T12) → T13 → T14 → T15 →
T16 → T17 → T18 → T19 → T20 → T21 → T22 → T23 → T24.

## 3. Design notes

### 3.1 Effective permissions

`effective(user) = profile ∪ ⋃ permissionSets(user) ∪ ⋃ sets(groups(user)) − mutingSet(group)` per group, where a
muting set only subtracts from that group's own sets (Salesforce semantics). Object: View All ⇒ Read; Modify All ⇒
Read, Create, Edit, Delete, View All. FLS: most permissive wins; system fields (id, owner, created/updated) are always
readable when the object is. The result is cached in Valkey under `perm:{tenant}:{user}:{permVersion}`; any profile,
set, group, assignment or hierarchy change bumps `tenant_settings.perm_version` in the same transaction.

### 3.2 Sharing

Exactly the fixed design in §6.4: `principals(user)` (user, transitive public groups, queues, org units + ancestors
for role rules) cached by `permVersion`; `user_visibility_closure` materialised per viewer (own records, descendant
org units' owners and direct reports when "grant access using hierarchies" is on, queues); `record_share` partitioned
by object with `(tenant_id, object, principal_id, record_id)` indexes; the predicate from §6.4 verbatim. Ownership
changes update the closure synchronously; rule-based shares converge through the `sharing` queue (< 60 s p95).

### 3.3 Audit chain (Q15)

- In the audited transaction: `INSERT INTO audit_log (tenant_id, id, seq, occurred_at, actor, action, object, record_id,
payload)` where `seq` comes from a per-tenant sequence; `hash` and `prev_hash` are NULL. `sm_app` has INSERT only.
- The `audit-chain` job (per tenant, serialised by BullMQ group key, never by a database lock) takes unchained rows in
  `seq` order once their transactions are committed, computes `hash = SHA-256(prev_hash ‖ canonical(row))` for each,
  and writes the hashes plus one `audit_batch(tenant_id, first_seq, last_seq, merkle_root, prev_root)` row. A
  dedicated role `sm_audit` may set a row's hash exactly once (a trigger rejects any other UPDATE).
- The verifier re-walks the chain and the batch roots; Setup → Audit log shows the last verified point. Gaps
  (a rolled-back `seq`) are recorded explicitly, so they are not mistaken for deletions.

### 3.4 Invitations and SSO

An invitation creates a `PENDING` user plus a single-use token (7 days). Accepting sets a password or links a
Google/Microsoft identity whose verified email matches the invited address; that is the only just-in-time linking
(§6.1). Seats are counted when plans exist (P05).

## 4. Data model diff (all tenant tables: `tenant_id` leads every key, RLS forced, UUIDv7)

- Identity: `invitation`, `login_history`; `user` gains `org_unit_id`, `manager_id`, `profile_id`, `title`,
  `department`, `phone`, `deactivated_at`.
- Hierarchy and access: `org_unit`, `org_unit_closure`, `profile`, `permission_set`, `permission_set_group`,
  `permission_set_group_member`, `permission_assignment`, `system_permission`, `object_permission`,
  `field_permission`, `public_group`, `group_member`, `queue`, `queue_member`, `queue_object`, `org_wide_default`,
  `sharing_rule`, `record_share` (partitioned by object), `user_visibility_closure`.
- Governance and jobs: `audit_log` (partitioned monthly) + `audit_batch`, `setup_audit`, `outbox_event` (partitioned
  daily), `job_run`.
- Roles: `sm_audit` (chain writer). All migrations expand-only.

## 5. API diff (zod contract + OpenAPI + ≥ 4 integration tests each, including cross-tenant 404)

Every route checks a system permission (`manage_users` for users and invitations; `customize_application` /
`view_setup` for Setup; `view_all_data` is never implied).

- `/v1/users` (list/search, get, patch, deactivate, reactivate) · `/v1/invitations` (create, resend, revoke) ·
  `POST /auth/invitations/accept` (+ OIDC accept)
- `/v1/org-units` (tree, create, rename, move, delete-if-empty)
- `/v1/profiles`, `/v1/permission-sets`, `/v1/permission-set-groups` (+ assignments)
- `/v1/groups`, `/v1/queues` (+ members, objects)
- `/v1/sharing/owd`, `/v1/sharing/rules` (+ recalculation status), `POST /v1/records/{object}/{id}/share` (manual;
  exercised with the fixture object until P02)
- `/v1/audit-log` (+ verify), `/v1/setup-audit`, `/v1/login-history`, `/v1/me/sessions` (list, revoke, revoke others)
- `GET /v1/me/access/{object}/{id}` ("Why can I see this?") — internal

## 6. Test plan

- **Unit:** permission engine (union, muting, implications, FLS), closure maintenance (moves, cycles), principal
  expansion (nested groups, cycles), criteria evaluator, audit hashing and Merkle roots; coverage gates enforced.
- **Integration:** every endpoint's four cases (happy, validation, permission denial, cross-tenant 404), RLS on every
  new table (`db:rls-audit`), `sm_app` cannot UPDATE/DELETE `audit_log`, the chain detects tampering.
- **Permission matrix (exit gate):** ≥ 150 table-driven cases (T15).
- **Performance:** T22 at bank scale; results recorded in the handoff.
- **E2E + axe:** T23 journeys, light and dark; visual baselines for the Setup template (T5).

## 7. Risks

1. **Closure size and recompute time at 800+ users** (§6.4 estimates ~500k rows per tenant). Mitigation: incremental
   updates per affected subtree, measured in T22 before any UI depends on it.
2. **Audit chaining lag or backlog under bulk writes.** The chain trails commits by about a second; the verifier and
   Setup show the last verified point. A backlog alarm is a follow-up for the observability work.
3. **Permission caching errors** (stale access after a change). Every mutation bumps `permVersion` in the same
   transaction; tests assert the new decision takes effect on the next request.
4. **Scope.** 24 tasks. If time is short, trim the Setup editors' polish (T18–T20), never the engine, the matrix suite
   or the gates (§1.5 tie-break order).

## 8. Definition of Done for P01

Every task meets §13.4. The exit gate is evidenced: the permission matrix suite (≥ 150 cases) green in CI; the T23
journeys green; `db:rls-audit` green with every new table; coverage gates passing; T22 numbers recorded; P01-handoff.md
written.
