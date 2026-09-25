# CLAUDE.md — SalesMaker 2.0

Standing rules for working in this repository. Derived from `docs/spec/MASTER_SPEC.md`
(§0, §3, §13), which is the **single source of truth**. If this file and the spec
disagree, the spec wins. Never edit the spec silently: propose a change, and on owner
approval record it in `docs/spec/CHANGELOG_SPEC.md` and then edit the section.

## What this is

SalesMaker 2.0 is a multi-tenant, AI-native CRM and sales-execution SaaS in the class of
Salesforce Sales Cloud. It serves the **entire sales and business-development force**: field
sales, account and relationship managers, business development, inside sales, and telesales.
Telesales is one first-class motion among several, not the product's focus. It is sold self-serve at a
**flat price per organisation** to teams of 5 to 1,000+ reps. It is a completely separate
product from WealthEngine, and reuses nothing from it.
Namespace `salesmaker`, package scope `@sm/*`.

## Golden rules (non-negotiable; §0.4)

1. **No tenant data access without a TenantContext.** Every tenant-table query runs in a
   transaction that has executed `SELECT set_config('app.tenant_id', $1, true)`. RLS is
   **enabled and forced** on every tenant table (`enable_tenant_rls()` helper, CI gate
   `db:rls-audit`).
2. **Every CRM record mutation goes through `RecordService`** (§3.7). Feature code never runs
   direct INSERT/UPDATE/DELETE statements against CRM object tables.
3. **Every CRM read goes through the Query Engine** (§3.8), which applies sharing (§6.4) and
   FLS (§6.5). Controllers never run ad-hoc queries against CRM tables.
4. **LLM output is never executed as SQL or code.** AI emits zod-validated JSON that runs
   through the same engines as a human, *as that human* (§8).
5. **No hard-coded user-facing strings** (`next-intl` keys). **Logical CSS only**
   (`ms-/me-/ps-/pe-/start-/end-`; `ml-/mr-/pl-/pr-/left-/right-/text-left/…` are lint errors).
6. **Design tokens only** (§9). Feature code contains no raw hex values, px font sizes or ad-hoc shadows.
7. **Every endpoint** needs a zod contract in `packages/contracts`, a permission check, an OpenAPI entry, and
   integration tests, including a **cross-tenant denial** test (B gets **404**, never 403).
8. **Money is never a float.** Use `numeric(18,2)` in Postgres and `Decimal` (decimal.js) in TS, always with an ISO-4217 code.
9. **Time is stored in UTC** as `timestamptz`. Business dates (close date, birthday) use `date`.
10. **Everything external is idempotent**: webhooks in and out, imports, billing events, and `Idempotency-Key` on the public API.

Tie-break order when requirements conflict (§1.5): **Security & tenant isolation > Data
integrity > Rep's daily-loop speed > Configurability > Visual polish > Feature breadth.**
One engine per concern: one query engine, one record service, one permission engine, one
expression language (`@sm/formula`) and one automation runtime. Features compose these engines and never re-implement them.

## Stop and ask the owner (§0.3)

- Any change to a locked decision (§1.4, ADRs 0001–0029).
- Any change to tenancy, the permission model, or the audit-log design.
- A paid third-party service, or a runtime dependency licensed outside MIT/Apache-2.0/BSD/ISC.
- A destructive migration that does not follow expand/contract.
- Anything that sends real email/SMS/WhatsApp/calls or charges real money outside test mode.
- Ambiguity where a wrong guess would cost more than a day to undo.

For anything else, make the call, record it in the phase plan or an ADR, and move on.

## Architecture (§3)

- **Turborepo + pnpm** monorepo with TypeScript strict (`noUncheckedIndexedAccess`) everywhere, and Python only in `apps/ml`.
- `apps/web` Next.js App Router + React 19 (Vercel) · `apps/api` NestJS on Fastify (modular
  monolith) · `apps/worker` BullMQ consumers · `apps/realtime` WS gateway (invalidation events
  only, never records) · `apps/control-api` global control plane (tenant directory, login
  routing, Stripe, entitlements, **no CRM data**) · `apps/ml` (P07, optional) · `apps/fakes`.
- `packages/`: `ui` (`@sm/ui`, no data fetching), `contracts` (zod → OpenAPI 3.1), `db`
  (Prisma schema/migrations + `withTenant`), `query-engine` (SMQ → Kysely), `permissions`,
  `metadata`, `formula`, `ai`, `i18n`, `emails`, `sdk`, `config`, `testing`, `integrations`.
- **PostgreSQL 16** (shared DB, RLS per tenant) uses **Prisma** for schema, migrations and platform tables, and
  **Kysely** for dynamic metadata SQL inside the same tenant transaction. PgBouncer runs in transaction mode.
- DB roles: `sm_migrator` (DDL only), `sm_app` (runtime, not owner, no BYPASSRLS),
  `sm_readonly_reports` (replica), `sm_support` (break-glass, audited).
- Every tenant table has `tenant_id` leading its PK or composite unique index, and every index leads
  with `tenant_id`. IDs are UUIDv7. Standard columns are listed in §4.1.
- **Regional cells** (§3.4): the cell base URL always comes from the tenant directory and is never
  hard-coded. There are no cross-cell joins. MVP runs one cell (eu-central-1).
- Writes use a **transactional outbox**. The relay feeds BullMQ, and every job carries a `tenantId` with per-tenant
  fairness keys.
- Caching covers metadata (`metadataVersion`) and effective permissions (`permVersion`) only. **Record
  data is never cached** server-side.
- Request lifecycle (§3.6): request-id → rate limit → auth → TenantContext → UserContext → zod
  → controller → service → RecordService/QueryEngine → FLS-stripping serializer → RFC 9457 errors.
- Every third-party integration sits behind an adapter interface with a **fake**. **No real
  third-party calls happen in CI.**

## Engineering process (§0.2, §13)

- **Phases P00–P12** (see `docs/phases/ROADMAP.md`). For each phase: re-read this file, the spec
  sections, the ADRs and the previous `Pxx-handoff.md`. Then write `docs/phases/Pxx-plan.md` and **stop for approval**.
  Then run task by task, updating `Pxx-tasks.md`. Finish with `Pxx-handoff.md` and a ROADMAP update.
- Branches: `feat/Pxx-<slug>`, `fix/<slug>`, `chore/<slug>`. Trunk is `main` (protected).
  **Conventional Commits**, squash-merge, **one PR per feature task** (≤ ~600 changed lines
  excluding generated code, lockfiles and snapshots), using the PR template. Self-merge only once CI is green.
- Write tests first for non-trivial logic. Coverage gates: ≥ 90% lines on `formula`, `permissions` and
  `query-engine`; ≥ 80% across packages overall. Every endpoint has ≥ 4 integration tests (happy path, validation,
  permission denial, cross-tenant denial, plus FLS stripping and optimistic lock where relevant).
- **Definition of Done (§13.4):** acceptance criteria are demonstrated. `pnpm verify` is green (lint, typecheck,
  unit, integration, rls-audit, i18n key check, logical-CSS lint, OpenAPI drift). There are permission, FLS and cross-tenant
  tests. All UI states are designed (loading, empty, error, no-permission), with a keyboard path and clean axe results. Changes
  are audited. Docs are updated (ADR, `docs/modules/*`, OpenAPI descriptions). No TODOs without an issue, no
  `console.log`, and no disabled lint rules without a justification comment.

## Commands (available once P00 lands)

```bash
docker compose up                 # Postgres 16, Redis 7, MinIO, Mailpit, fakes, OTel + Jaeger
pnpm install && pnpm dev          # web, api, worker, realtime with hot reload
pnpm verify                       # the full local gate — must be green before any PR
pnpm db:seed --scenario=agency|bank --scale=demo|load
```

## Design (§9, summary; the spec tables are authoritative)

The look is Salesforce Lightning density with Linear/Attio polish: dense, calm, fast and keyboard-first.
**Jade** is the brand colour for primary actions, selection and focus. **Iris is reserved exclusively for AI.**
Graphite neutrals, status colours carry meaning only, and Lost = graphite (not red).
Inter Variable plus JetBrains Mono. Light/Dark/System themes × Comfortable/Default/Compact density.
Every screen uses one of templates T1–T10. Components live in `@sm/ui` with Storybook
stories for every variant × state × theme × density. Accessibility target is WCAG 2.2 AA, and axe is release-blocking.

## Docs map

`docs/spec/MASTER_SPEC.md` (the source of truth) · `docs/spec/CHANGELOG_SPEC.md` · `docs/adr/` (MADR; index in
`docs/adr/README.md`) · `docs/phases/` (ROADMAP, plans, tasks, handoffs) · `docs/modules/` ·
`docs/runbooks/` · `docs/spec/ERD.md` (from P00/P02).
