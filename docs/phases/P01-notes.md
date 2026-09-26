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
