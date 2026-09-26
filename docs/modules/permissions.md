# Permissions

Spec: §6.2, §6.5 · ADR: 0007 · Code: `packages/permissions`, `apps/api/src/access`, `apps/api/src/permissions`,
`apps/api/src/setup/permission-setup.service.ts` · Tables: [ERD](../spec/ERD.md#hierarchy-and-permissions-p01)

Permissions answer "may this user do this kind of thing?": use a Setup page, create a lead, edit the `amount`
field. Which _records_ they may touch is [sharing](sharing.md). Access to a record needs both.

## Model

| Piece                    | What it is                                                                                                                                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Profile**              | Exactly one per user. Its grants live in its own permission set of kind `PROFILE`. Built-in: System Administrator (grants locked), Standard User, Read Only; custom profiles can be added.                                       |
| **Permission set**       | Kind `STANDARD`. Assigned to users directly or through a group. **Additive only**: a set can grant, never take away.                                                                                                             |
| **Permission set group** | A bundle of standard sets, with an optional **muting set** (kind `MUTING`) that removes flags from the bundle only (never from the profile or directly assigned sets).                                                           |
| **Grants**               | `system_permission` (a name from the catalogue, e.g. `view_setup`, `manage_users`, `customize_application`, `view_all_data`), `object_permission` (read/create/edit/delete/view all/modify all), `field_permission` (read/edit). |

Objects and fields are named by their API names from `@sm/metadata`'s standard catalogue (custom objects arrive in
P02 with the metadata engine).

## Effective permissions

`effectivePermissions()` (`@sm/permissions`, pure, ≥ 90% coverage gate) computes a user's permissions as
**profile ∪ assigned sets ∪ (each group's sets − its muting set)**, then:

- Object flags are closed under their dependencies: create/edit need read, delete needs edit, View All needs read,
  Modify All needs delete and View All (and, per the approved plan, create). Muting a flag also removes what
  depended on it.
- `view_all_data` / `modify_all_data` widen object access on every object but never bypass field-level security.
- FLS is most-permissive across sources. System fields are always readable and never editable; required fields stay
  editable so records can be saved.
- A deactivated, inactive or deleted user holds nothing, whatever is assigned.

Results are cached in Valkey under `perm:{tenant}:{user}:{permVersion}`. **Every** change that can alter them
(grants, assignments, group membership, a user's profile, unit, manager or status) bumps
`tenant_settings.perm_version` through statement triggers, so a stale entry is never addressed again. No code path
can forget to invalidate.

## Enforcement

- **Endpoints:** `@RequireSystemPermission('…')` (Nest guard) on every Setup route. Reading Setup needs
  `view_setup`; users, org units, profiles, sets and groups change with `manage_users`; org-wide defaults and sharing
  rules with `customize_application`.
- **Records:** `AccessService` (`apps/api/src/access`) checks, in order, tenant → system → object → record (sharing)
  → FLS (§6.2). `check`/`assert` answer one action on one record; `describe` explains the decision ("Why can I see
  this?"). A record the caller cannot see is **404**; one they can see but not change is **403**. P02's
  RecordService and Query Engine call it; nothing else may.
- **UI:** `/v1/me` lists the caller's system permissions. The shell hides Setup without `view_setup` and shows
  "Setup is for administrators" on a direct URL; the API refuses regardless.

## Guard rails

- The System Administrator profile's grants cannot be changed through the API, so a workspace cannot lock itself
  out of administration.
- Grants sent to the API are closed under the dependencies before storage; a trigger enforces the same rules for
  `PROFILE` and `STANDARD` sets (muting sets keep exactly what they name).
- Deletes refuse what is in use: a profile only when custom and unassigned, a set or group only when unassigned
  (and ungrouped). Every change writes a `setup_audit` row with before and after.

## Tests

`packages/permissions/test` (engine rules), `apps/api/test/permission-matrix.test.ts` (310 cases across profiles,
sets, muting, OWD, hierarchy, groups, queues, rules and manual shares, with expectations from an oracle written from
the spec), and the Setup API suites (happy path, validation, permission denial, cross-tenant 404).
