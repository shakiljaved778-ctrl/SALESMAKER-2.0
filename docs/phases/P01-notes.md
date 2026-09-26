# P01 working notes (input for the handoff)

Deviations from the plan or spec, calls the spec leaves open, and follow-ups, recorded as they happen.

## Decisions the spec leaves open

- **Web coverage gate (T01).** The unit gate covers the BFF (`apps/web/src/server`), which owns cookies, CSRF,
  tenant resolution and OIDC state. Pages, components and the browser session code are covered by the e2e journeys.
- **Sharing defaults for Quote, Contract and Order (T02).** §6.3 names defaults for seven objects only. Quote is
  `CONTROLLED_BY_PARENT` (master-detail to its opportunity, the only model allowed); Contract and Order are `PRIVATE`.
- **Object chip colours (T02).** §9.9 gives colours for Lead, Account, Contact, Opportunity, Campaign, Quote, Order
  and Task (Activity). Product and Contract are not listed and use graphite. Iris is never used: it means AI.
- **Object icons (T02).** §9.9 fixes one Lucide icon per object without naming them: `user-round-plus` (Lead),
  `building-2` (Account), `contact-round` (Contact), `target` (Opportunity), `megaphone` (Campaign), `package`
  (Product), `file-text` (Quote), `file-signature` (Contract), `shopping-cart` (Order), `list-checks` (Activity).
- **Standard field API names (T02)** are snake_case and equal the column names; lookups end in `_id`. Labels live in
  `@sm/i18n` under `objects.<object>.fields.<camelCase>`, with the §4.1 columns shared under `objects.common`.
- **Field-level security scope (T02).** System fields (ids, audit stamps, conversion links, roll-ups) and required
  fields are outside FLS: system fields are always readable and never editable, and required fields stay editable so
  records can be saved (Salesforce behaves the same way).
- **Closure maintenance (T03)** is done by triggers on `org_unit`, not by application calls, so no code path can
  change the tree without the closure. The trigger functions are `SECURITY DEFINER` (schema owner) and `sm_app` has
  only SELECT on `org_unit_closure`. Moves and manager changes take a per-tenant transaction advisory lock, which
  stops two concurrent moves from forming a cycle between them.
- **Profiles own a permission set (T04).** Each profile's grants live in its own `PROFILE`-kind permission set, as in
  Salesforce, so system, object and field grants reference only `permission_set`. Kinds are enforced by triggers:
  profiles point at `PROFILE` sets, group muting sets are `MUTING`, and only `STANDARD` sets are assigned or grouped.
- **Object access is stored closed under its dependencies (T04).** A check constraint mirrors the Salesforce rules
  (create/edit need read, delete needs edit, view all needs read, modify all needs delete and view all), and
  `normaliseObjectAccess` applies the same closure before writing.
- **`perm_version` is bumped by statement triggers (T04)** on every permission table, on `org_unit` inserts, deletes
  and moves, and on `user` inserts, deletes and changes to profile, org unit, manager, status or deactivation. No code
  path can forget to invalidate the cache.
- **Default profiles (T04)** are created at signup in the organisation's default locale; the owner gets System
  Administrator. Standard User: full access to leads, accounts, contacts, opportunities, activities and quotes;
  create and edit on contracts and orders; read on campaigns and products; `run_reports` and `use_ai_assistant`.
  Read Only: read everything, read-only FLS, `run_reports`. Organisations created before P01 get profiles from the
  identity seeds (T16).
- **The outbox relay never reads across tenants (T07).** A commit that writes outbox events NOTIFYs `sm_outbox`
  with its tenant id, and the relay drains that tenant inside an ordinary tenant transaction, so RLS still applies.
  To catch events a missed notification left behind (worker down, listener reconnecting), a periodic sweep asks the
  control plane for the cell's tenant ids (new service route `GET /cp/v1/cells/self/tenants`) and drains each one.
  The alternatives were a cross-tenant relay role, or a global table of tenants with pending events; both would
  need an RLS exemption, which is a tenancy change, so neither was used.
- **Per-tenant fairness on open-source BullMQ (T07).** BullMQ's group keys are a paid Pro feature, which §0.3 rules
  out. Instead, each queue counts every tenant's jobs in flight in Valkey, and a new job's priority is that count: a
  tenant's first job runs at priority 1, its thousandth at 1000. The queue therefore interleaves tenants round-robin,
  and one tenant's large import cannot starve the others. Completion or dead-lettering frees the slot.
- **BullMQ 6.3.9 (MIT)** is pinned (ADR-0002 addendum at the P01 handoff). Custom job ids must not contain `:`, so
  dead-letter ids are `<queue>.<job id>`.
- **Outbox ordering (T07).** Events from one transaction share `created_at`, so a `seq` column (bigserial) orders
  them; consumers see events in insert order within a tenant.
- **Cell-wide system jobs (T07)** such as outbox partition maintenance carry `tenantId: null` and never touch tenant
  rows. Partition DDL runs through `outbox_maintain_partitions()`, a `SECURITY DEFINER` function owned by the schema
  owner. It creates daily partitions with forced RLS and drops those past the 7-day retention; the runtime role
  holds no DDL rights.
- **LISTEN needs a session (T07).** Behind PgBouncer's transaction pooling, set `CELL_DATABASE_LISTEN_URL` to a
  direct database connection for the worker.
- **Engine semantics (T05).** Muting removes a flag and whatever depended on it (muting Delete also removes Modify
  All; muting Read removes everything on that object). As the approved plan states, Modify All implies Create as
  well; Salesforce leaves Create separate. `view_all_data` / `modify_all_data` widen object access on every object,
  custom ones included, but never bypass FLS. A deactivated, inactive or deleted user holds no permissions, whatever
  is assigned. The effective result is cached per user under `perm:{tenant}:{user}:{permVersion}`; the version is
  read before the grants, so an entry is never older than its key.
- **Owner visibility (T08).** A viewer's closure holds themselves, users in org units strictly below theirs (peers
  in the same unit do not see each other, as with Salesforce roles), their direct reports through `manager_id` (the
  spec says direct, so reports of reports are reached only through the org hierarchy), and the queues they belong
  to. Only `rebuild_user_visibility()` writes the closure: it runs as the schema owner, is serialised per tenant, and
  is set-based. A change can rebuild the affected viewers in its own transaction (`users_above_org_units` finds
  them), or emit `sharing.visibility_changed` for the worker. The Setup API (T14) chooses between them per change.
- **Principals (T08)** separate the user's own org unit (matches "role" shares) from their unit plus its ancestors
  (matches "role and subordinates" shares). A flat id list would let a share to role X reach users below X.
- **Share identity (T09).** A share is unique per (record, principal, reason, `source_id`). `source_id` is the rule,
  team membership, territory or parent record that created it, and the nil UUID for manual shares. This makes
  recalculating one rule an exact delete-and-insert of its own shares, and lets two sources grant the same principal
  independently. A partial or `NULLS NOT DISTINCT` unique index would have done the same, but Prisma cannot express
  either, and the drift check would fail.
- **Predicate details (T09).** The owner always sees their own records, even before their closure row exists. Only
  the viewer's own org unit matches `ORG_UNIT` shares; their unit and its ancestors match `ORG_UNIT_AND_SUBORDINATES`
  shares. `CONTROLLED_BY_PARENT` grants access to the child at the same level as its parent, through any parent
  lookup. A child with no parent falls back to owner, hierarchy and shares. Parents are followed at most three
  levels deep (activity → contact → account); anything deeper is denied rather than being an unbounded query.
- **Record tables (T09).** Standard CRM tables arrive in P02, so rule recalculation takes the object's table from the
  caller. The worker defaults to a table named after the object, and tests use fixture tables with the §4.1 columns.
  The T15 permission matrix runs on the same fixtures.
- **Owner-based rules follow membership (T09 → T14).** An owner-based rule depends on who is in its source group or
  org unit, so the Setup API emits `sharing.rule_changed` for the affected rules when group membership or placement
  changes.
- **Raw writes count with RETURNING (T09).** Inside a tenant transaction, Kysely's raw statements run through
  Prisma's raw query API, which reports rows, not affected counts.
- **Record access per action (T10)**, following Salesforce. Read needs Read. Edit needs Read-Write. Delete, transfer
  and share need Full (owner, hierarchy, queue or a Full share). A record the caller cannot see at all is a 404; one
  they can see but not change is a 403. Before P02 creates the object tables, every record lookup finds no table
  and answers "none" (404).
- **Audit sequences (T11).** Each tenant gets its own Postgres sequence, created on first use by
  `audit_next_seq()`, so audited transactions never wait on each other. The chain job stops at a missing number
  until a later row is five minutes old: longer than any transaction may run, so that number must have rolled back.
  It is then declared in the batch's `gaps`. A row that later appears inside a declared gap fails verification.
- **Hash scope (T11).** A row's hash covers tenant, id, seq, `occurred_at` (at microsecond precision, as UTC text),
  actor, on-behalf-of, action, object, record, canonical payload (keys sorted) and request id:
  `hash = SHA-256(prev_hash + "\n" + canonical JSON)`. The first row chains from 64 zeros. Batches record their
  Merkle root and the previous root.
- **Who may write what (T11).** `sm_app` may insert and select audit rows, never update or delete them. `sm_audit`
  (a new bootstrap role, `CELL_AUDIT_DATABASE_URL`, used only by the worker) may set `prev_hash`, `hash` and
  `chained_at` exactly once. A trigger enforces this even for the owner; the only way around it is a superuser
  switching triggers off, which is what the tamper tests do. Monthly partitions get the same grants and forced RLS
  as they are created.
- **Serialising chain runs (T11)** uses a Valkey lock plus a "dirty" mark, per the addendum's "never a database
  lock". Every request marks the tenant dirty before trying the lock. The holder clears the mark before chaining,
  and after releasing the lock it runs again if the mark came back. No request is lost in any ordering. A daily job
  chains and verifies every tenant, recording the result in `audit_verification`.
- **Audit viewers need `view_setup` (T11).** P02 must mask hidden-field history in payloads (§6.5) before record
  changes are audited.
- **Remote sign-out is immediate (T12).** Access tokens are stateless and valid for 15 minutes. Revoking a session
  therefore also writes `revoked-session:{id}` to Valkey for the token lifetime, and the auth guard refuses tokens
  of listed sessions. If Valkey is unreachable the check fails open (logged); the refresh token is revoked in the
  database either way.
- **Login history (T12)** holds one append-only row per sign-in attempt: method (password, google, microsoft, otp,
  recovery_code), outcome, user (when known), the email HMAC (when the user is unknown), session, IP and user agent.
  A deactivated user is refused like a wrong password, so the response does not reveal the deactivation. SSO still
  links only to an existing user of the workspace (invited or created); T13 adds invitation acceptance on top.
- **Invitations (T13).** An invitation is identified in the API by its pending user's id: `/v1/invitations/{id}` is
  the user, and resend, withdraw and accept act on that user's latest live invitation. Withdrawing removes the
  pending user, which never signed in and owns nothing, so the address can be invited again. Only the token's
  SHA-256 is stored, and the email's idempotency key is a digest of the token.
- **User changes keep access current (T13).** A change of org unit or manager rebuilds, in the same transaction,
  the visibility of the user, their old and new managers, and the users above their old and new units. A change of
  org unit also queues recalculation of the active owner-based rules. The workspace owner and the caller cannot be
  deactivated, and deactivation ends every session at once.
- **Setup API permissions (T14).** Reading any Setup entity needs `view_setup`. Org units, profiles, permission
  sets and groups, public groups and queues change with `manage_users`; org-wide defaults and sharing rules with
  `customize_application`. Manual shares need no system permission: the caller needs Full access to the record
  (owner, above the owner, or Modify All), else 403, or 404 when they cannot see it.
- **Deletes refuse what is in use (T14).** An org unit goes only when it has no child units, users, group or queue
  memberships, or rules naming it; a group only when no other group, queue or rule refers to it; a profile only
  when it is custom and unused; a permission set or group only when unassigned (and ungrouped). Manual shares to a
  deleted group, queue or unit are removed with it. Deletes are hard deletes, so the name can be reused; the Setup
  audit trail keeps the history.
- **Access stays current after Setup changes (T14).** Every write bumps `permVersion` through the database triggers.
  A move rebuilds, in the same transaction, the visibility of the users above the moved subtree before and after
  (and of the subtree's users when a queue names a subtree or group). Queue membership changes rebuild the
  visibility of users who joined or left. Group membership changes and unit moves queue a recalculation of every
  active owner-based rule. Rule create/update (when its source, criteria, target, access or activity changes)
  creates a `job_run` and emits `sharing.rule_changed` with its id; deleting a rule emits `sharing.rule_deleted`.
- **Muting sets name single flags (T14, migration 0014).** A muting set removes what it names, so "mute Edit" must
  not also mute Read. The dependency rules (edit needs read, …) moved from CHECK constraints into a trigger that
  enforces them for PROFILE and STANDARD sets and skips MUTING sets. Grants sent to the API are closed under the
  dependencies before they are stored.
- **Lockout guard (T14).** The built-in System Administrator profile's grants cannot be changed through the API, so
  a workspace cannot remove its own ability to administer itself. Sharing rules and manual shares are refused on
  objects whose default is Public Read/Write or Controlled by Parent (they would add nothing). "Grant access using
  hierarchies" is fixed on for standard objects.
- **Queue-owned records (T14).** Queues cannot yet check whether they own records (no object tables until P02);
  deleting a queue that owns records must be refused once P02 adds them.
- **Permission matrix (T15).** Hierarchy expectations come from an oracle written from §6.3 alone (own records,
  anything owned in a unit strictly below yours, your direct reports'), not from the implementation. Sharing rules in
  the suite are recalculated with the worker's own `recalculateRule`, in small batches. Observed semantics worth
  knowing: an Org-Unit-and-Subordinates share does not reach users _above_ that unit; a Controlled-by-Parent child
  never exceeds its parent's level (a Read-Write rule on the account gives edit, not delete, on its contacts); queue
  ownership gives members Full access but does not flow up the hierarchy; Public Read/Write still needs the object
  edit permission.
- **Demo seeds (T16).** The seed lives in the API app (`apps/api/src/seed/`) because it reuses the same provisioning as
  sign-up (default profiles, org-wide defaults). It reserves each workspace through the control plane (idempotency
  key `seed:<scenario>`), so the control API must be running, then writes the plan in one tenant transaction. A
  workspace that already exists is left untouched. All seeded users are active, verified and share one demo password
  (`SEED_PASSWORD`, default printed by the command); it refuses to run with `NODE_ENV=production`. Emails use the
  reserved `.example` domain. `--scale` is accepted now and matters once P02 seeds CRM records. The spec's staging-only
  `demo+…@salesmaker.app` users and "Reset demo" action belong to the staging deployment work, not this task.
- **Browser → cell calls go through a BFF relay (T17).** The page keeps its access token in memory and CSP allows only
  `connect-src 'self'`, so `/api/v1/…` on the workspace origin relays to the cell's `/v1/…` (base URL from the tenant
  directory) with the caller's bearer token, query string, JSON body and idempotency key, and relays problems as
  they are. Writes must come from this origin; a GET without an Origin header is accepted because the bearer token
  cannot be attached by another site. Only `/v1/` paths are relayed. On a 401 the page refreshes its session once
  and retries.
- **Hiding Setup (T17).** `/v1/me` now lists the caller's system permissions. The sidebar and command menu hide
  Setup without `view_setup`; a direct URL shows a "Setup is for administrators" page, and the API answers 403
  regardless. Write controls are hidden without `manage_users`.
- **Popovers inside overlays (T17).** Combobox, Select, DropdownMenu, Popover and HoverCard portal to the body at
  `--z-popover` (40), below modals (70) and sheets (60), so a picker inside a dialog opened underneath it. They now
  read the enclosing overlay from context and stack at `calc(var(--z-modal) + 1)` (or the sheet's) instead. The
  §9 z-scale tokens are unchanged.
- **Next.js agent files.** `next dev` writes `AGENTS.md` and `CLAUDE.md` into the app; `agentRules: false` in
  `next.config.ts` turns that off so they are never committed.
- **Grants editor (T18).** One editor serves profiles, permission sets and muting sets. Ticking an object flag
  brings its dependencies (Edit brings Read) and unticking removes what depended on it, with the same rules the
  server applies (`@sm/permissions`); a muting set keeps exactly what is ticked. Saving a profile or set renames it
  first and then replaces its grants, each with the version the previous step returned.
- **Moving an org unit (T18)** is a dialog with a parent picker that leaves out the unit and its own subtree, so a
  move never needs drag and drop; the tree itself follows the WAI-ARIA tree pattern (roving focus, arrows,
  Home/End, Enter to select, mirrored arrows in RTL).
