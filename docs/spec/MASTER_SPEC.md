SALESMAKER 2.0 — MASTER BUILD PROMPT

> **What this is:** the constitution for building SalesMaker 2.0 with Claude Code on GitHub. Paste this whole file into Claude Code in an empty repository as the **first message of the project**. Everything after it (phase prompts P00–P12) refers back to section numbers in this document.
>
> **Version:** 1.0 · **Owner:** Shakil Javed · **Date:** 25 Sep 2026

---

## §0. OPERATING INSTRUCTIONS FOR CLAUDE CODE (read first, obey always)

You are the **principal engineer and product-minded tech lead** for SalesMaker 2.0, a multi-tenant, AI-native CRM and sales-execution SaaS platform in the class of Salesforce Sales Cloud. You will build it phase by phase in this GitHub repository. You write production-grade code, not demos.

### 0.1 What to do in THIS session (the session where this prompt is pasted)
1. Save this entire prompt verbatim to `docs/spec/MASTER_SPEC.md`. It is the single source of truth. Never edit it silently. If a change is needed, propose it, and on approval record it in `docs/spec/CHANGELOG_SPEC.md` and edit the section.
2. Create `CLAUDE.md` at the repo root using the content supplied with this pack (if not supplied, derive it from §13 and §3).
3. Create one ADR per locked decision in §1.4 under `docs/adr/` (`0001-multi-tenant-shared-db-rls.md`, `0002-turborepo-nextjs-nestjs.md`, …) using the MADR template (Context · Decision · Consequences · Alternatives rejected).
4. Create `docs/phases/ROADMAP.md` from §14, with every phase listed and status `NOT STARTED`.
5. Reply with: (a) a one-page summary of your understanding, (b) the risks you see in the top 10 hardest parts, (c) any contradictions or gaps you found in this spec, as a numbered list of questions. **Do not write application code until the P00 prompt arrives.**

### 0.2 How every phase session runs
When a phase prompt (P00…P12) is pasted:
1. Re-read `CLAUDE.md`, the referenced §sections of `MASTER_SPEC.md`, the ADRs, and the previous phase's `docs/phases/Pxx-handoff.md`.
2. Enter plan mode. Write `docs/phases/Pxx-plan.md`: task breakdown (each task ≤ 1 PR, ≤ ~600 changed lines excluding generated code), data model diff, API diff, UI screens, test plan, risks. Stop for approval.
3. After approval, execute task by task: branch `feat/Pxx-<slug>` → tests first where the logic is non-trivial → implementation → `pnpm verify` green → open PR with `gh pr create` using the PR template → update `docs/phases/Pxx-tasks.md` checkboxes.
4. At the end of the phase, write `docs/phases/Pxx-handoff.md`: what shipped, deviations from spec (with reason), known issues, follow-ups, and how to demo it. Update `ROADMAP.md`.

### 0.3 Stop-and-ask rules (you MUST pause and ask the owner)
- Any change to a locked decision in §1.4.
- Any change to tenancy, the permission model, or the audit log design.
- Adding a paid third-party service or new runtime dependency with a licence other than MIT/Apache-2.0/BSD/ISC.
- A destructive migration (dropping or renaming a column or table holding data) not following expand/contract.
- Anything that sends real email, SMS, WhatsApp, calls, or charges real money outside test mode.
- When the spec is ambiguous and a wrong guess would cost more than a day to undo.

Everything else: make the call, document it in the plan or an ADR, and move on.

### 0.4 Non-negotiable golden rules (repeated in CLAUDE.md)
1. **No tenant data access without a TenantContext.** Every query against a tenant table runs inside a transaction that has executed `SELECT set_config('app.tenant_id', $1, true)`. RLS is enabled **and forced** on every tenant table.
2. **Every record mutation goes through `RecordService`** (§3.7). No direct `INSERT/UPDATE/DELETE` on CRM object tables from feature code.
3. **Every read of CRM records goes through the Query Engine** (§3.8), which applies sharing (§6.4) and field-level security (§6.5). No ad-hoc queries on CRM tables in controllers.
4. **No LLM output is ever executed as SQL or code.** AI produces typed, validated JSON (zod) that runs through the same engines a human would use, as that human (§8).
5. **No hard-coded user-facing strings.** All copy goes through i18n keys (`next-intl`). **CSS logical properties only** (`ms-/me-/ps-/pe-/start/end`, never `ml-/mr-/left/right`) so Arabic RTL can be switched on later with no refactor (§9.12).
6. **Design tokens only.** No raw hex values, pixel font sizes or ad-hoc shadows in feature code. Use the tokens in §9.
7. **Every endpoint** has a zod contract in `packages/contracts`, a permission check, an OpenAPI entry, and at least one integration test, including a cross-tenant denial test.
8. **Money is never a float.** `numeric(18,2)` in Postgres and `Decimal` (decimal.js) in TypeScript, always paired with an ISO-4217 currency code.
9. **Time is stored in UTC** (`timestamptz`). Presentation uses the user's timezone and locale. Business-date fields (close date, birthday) use `date`.
10. **Idempotency everywhere external:** webhooks in and out, imports, billing events, and the public API (`Idempotency-Key` header).

---

## §1. PRODUCT DEFINITION

### 1.1 One-line
SalesMaker 2.0 is one platform for the whole sales motion: generate and capture leads, route them, work them (calls, email, WhatsApp, SMS), qualify and convert them, build and forecast pipeline, quote and close, and hand off to fulfilment. It has an AI layer that scores, recommends, drafts, summarises and, with human approval, acts. It is sold as self-serve multi-tenant SaaS to organisations with **5 to 1,000+ sales users**.

### 1.2 Positioning
- **Salesforce-grade depth** (metadata-driven objects, role hierarchy, sharing rules, territories, approvals, forecasting) **without Salesforce's weight**: live in a day for a 5-person team, and able to scale to a 1,000-rep telesales floor.
- **AI-native, not AI-bolted-on.** Every screen has an AI affordance in the same place, and every AI action is explainable and reversible.
- **Telesales-first execution.** Dialer queues, dispositions, SLA timers, wallboards and gamification are first-class, not add-ons.
- **Global from day one.** Multi-currency, multi-timezone, locale formatting, regional data residency, English UI in v1, and an architecture that is ready for Arabic RTL.

### 1.3 Personas (design every screen for a named persona)
| Persona | Scale context | Top jobs-to-be-done | Primary surfaces |
|---|---|---|---|
| **Sales Rep / Telesales Agent** | 1 of 5–1,000 | Work my queue fast, log without typing, hit my target | Home "Today", Call Queue, Lead/Opp record, Softphone, Kanban |
| **Team Leader / Sales Manager** | Leads 5–15 reps | See who is behind, coach, approve discounts, commit forecast | Team dashboard, Forecast, Approvals inbox, Wallboard |
| **Regional / Sales Director** | 50–500 reps | Roll-up forecast, territory performance, pipeline coverage | Forecast roll-up, Dashboards, Territory reports |
| **Sales Ops / CRM Admin** | 1–10 per org | Configure objects, fields, rules, automations, users, permissions | Setup (admin console), Builders, Import |
| **Marketing / Lead Gen** | 0–20 per org | Capture leads, attribute sources, hand off cleanly | Web forms, Campaigns, Lead source reports |
| **Org Owner / Billing Admin** | 1 per org | Sign up, pay, manage plan and data residency | Onboarding wizard, Billing, Org settings |
| **Finance / Fulfilment (consumer)** | varies | Receive clean orders and invoices | Orders, Invoicing handoff, Webhooks |

### 1.4 LOCKED DECISIONS (from the owner's questionnaire; ★ = default accepted)
| # | Topic | Decision |
|---|---|---|
| 1 | Name | **SalesMaker 2.0** (code namespace `salesmaker`, package scope `@sm/*`) |
| 2 | Market | **Global from day one** |
| 3 | Business model | **Multi-tenant SaaS, self-serve signup, subscription billing** |
| 4 | Pricing | **Flat price per organisation** (not per seat). Plans are flat monthly or annual fees per org, differentiated by capability and **limits** (max users, storage, AI credits, API calls). See §12. |
| 5 | Vertical | **Horizontal core** with configurable objects and fields; no vertical templates in v1 |
| 6 | Tenancy | **Shared Postgres database, row-level security per tenant** |
| 7 | Org hierarchy | **Flexible unlimited-depth tree** (Company → Region → Branch → Team → Rep, or any shape) |
| 8 | Scale envelope (per tenant) | **1,000 users · 5M leads · 50M activities** |
| 9 | Territories | **Full Salesforce-style territory management** |
| 10 | Modules v1 | **All modules** in §2.1. Customer Support Cases are **v2** (reserved, not built). |
| 11 | Telephony | **Telesales-grade:** click-to-call, call logging, recording links, dialer queues, dispositions, agent states, wallboards |
| 12 | Channels | **Email (Gmail + Outlook two-way sync) + WhatsApp Business (Cloud API) + SMS** |
| 13 | AI depth | **AI-native across the product** |
| 14 | AI provider | **Anthropic Claude API behind a provider-abstraction layer** (swappable) |
| 15 | Agentic AI | **Yes, with human approval gates** |
| 16 | Design reference | **Salesforce Lightning information density + Linear/Attio polish and speed** |
| 17 | Colour | **Palette chosen by the architect and fixed as tokens in §9** (tenant can upload a logo; no tenant colour theming in v1) |
| 18 | Themes | **Light + Dark + Compact density** |
| 19 | Language | **English only in v1; RTL-ready architecture** (logical CSS, i18n keys, mirrored-icon flags) |
| 20 | Navigation | **Left sidebar + global command palette (⌘K) + tabbed record views** |
| 21 | Components | **shadcn/ui + Radix + Tailwind CSS, with the custom SalesMaker design system (`@sm/ui`) on top** |
| 22 | Mobile | **Responsive web + installable PWA in v1**; native (React Native/Expo) in v2 |
| 23 | Design spec | **Full mandatory design-system spec** (§9) |
| 24 | Stack | **Turborepo monorepo: Next.js (App Router) + TypeScript, NestJS API, PostgreSQL 16 + Prisma (+ Kysely for dynamic queries), Redis + BullMQ, S3-compatible storage, search behind an interface** |
| 25 | Hosting | **Vercel (web) + AWS (API, workers, DB, Redis, S3) in production**; Railway allowed for staging |
| 26 | Data residency | **Per-tenant region selection** at signup (regional "cells", §3.4) |
| 27 | Auth | **Built in-house:** email/password + Google/Microsoft SSO + enterprise SAML/OIDC + MFA (TOTP, WebAuthn/passkeys) |
| 28 | Public API | **REST + webhooks + OAuth 2.0 connected apps in v1**; GraphQL later |
| 29 | Engineering process | **Phased, CLAUDE.md, ADRs, per-phase task lists, test-first for logic, one PR per feature, GitHub Actions CI (lint, typecheck, unit, integration, e2e with Playwright)** |
| 30 | Billing | **Stripe** (Billing, Checkout, Customer Portal, Tax) |
| 31 | Permissions | **Salesforce-style:** profiles + org/role hierarchy + permission sets (and groups) + field-level security + org-wide defaults + sharing rules + manual and team sharing + territory access |
| 32 | Compliance | **SOC 2-ready controls, GDPR, Qatar PDPPL, UAE and KSA PDPL** |
| 33 | Audit | **Field-level history on every tracked field + immutable, hash-chained audit log** |
| 34 | Horizon | **MVP in 8 weeks** (core CRM, leads, pipeline, basic reports, billing), then the **full platform by ~week 26** |
| 35 | Prompt format | **This master prompt + phase sub-prompts P00–P12** |
| 36 | Pack | **CLAUDE.md + repo scaffold supplied** |
| 37 | Demo data | **Two seeded demo tenants:** a 5-rep agency and an 800-rep bank-style sales floor |
| — | Relationship to WealthEngine | **Completely separate product and codebase.** Reuse nothing. |

### 1.5 Product principles (tie-breakers when requirements conflict)
Priority order: **Security and tenant isolation > Data integrity > Speed of the rep's daily loop > Configurability > Visual polish > Feature breadth.**
1. **The rep's loop is sacred.** Open queue → call/message → disposition → next record must take **≤ 3 clicks and < 2 seconds of UI latency** end to end.
2. **Configure, don't code.** Anything an admin at a normal company would want to change (fields, stages, picklists, rules, layouts, automations) is metadata, not a deploy.
3. **One engine per concern.** One query engine, one record service, one permission engine, one expression language, one automation runtime. Features compose these engines; they never re-implement them.
4. **Explainable automation.** Every automated or AI-driven change leaves a visible trail: who or what did it, why, and how to undo it.
5. **Scale by default.** Every list is paginated by keyset, every heavy job is async with progress, and every index leads with `tenant_id`.

---

## §2. SCOPE

### 2.1 Module map and release cut
| # | Module | MVP (wk 1–8) | Full v1 (by wk 26) | Phase |
|---|---|---|---|---|
| M1 | Tenancy, signup, org settings, regions | ✅ | cells in 2+ regions | P00, P05, P12 |
| M2 | Identity and auth (password, Google/MS SSO, MFA) | ✅ | + SAML/OIDC enterprise SSO, SCIM | P00–P01, P12 |
| M3 | Org hierarchy, profiles, permission sets, FLS, OWD, sharing | ✅ | + territory-based access | P01, P10 |
| M4 | Metadata engine: custom fields, picklists, record types, layouts, validation rules, list views | ✅ fields and layouts | + **custom objects**, formula, roll-up fields | P02, P11 |
| M5 | Core objects: Lead, Account, Contact, Opportunity, Campaign; lead conversion | ✅ | — | P02 |
| M6 | Lead capture: CSV import, web forms, REST API, email-to-lead | ✅ | + WhatsApp inbound, Meta and LinkedIn lead ads | P03, P06 |
| M7 | Assignment rules, queues, SLA timers, territories; duplicate management | ✅ (no territories) | + full territory models | P03, P10 |
| M8 | Lead scoring | ✅ rules-based | + AI predictive and explainable | P03, P07 |
| M9 | Pipelines: multiple per org, custom stages, Kanban and list | ✅ | — | P04 |
| M10 | Activities: tasks, calls, meetings, notes, timeline, calendar | ✅ (manual logging) | + calendar sync | P04, P06 |
| M11 | Telesales: CTI adapter, softphone, dialer queues, dispositions, agent states, recording links, DNC, wallboard | — | ✅ | P06 |
| M12 | Channels: Gmail/Outlook sync, email templates, WhatsApp Cloud API, SMS | — | ✅ | P06 |
| M13 | Reports and dashboards | ✅ basic (tabular + summary, 6 widget types) | + drag-and-drop builder, matrix, scheduling, dynamic dashboards | P05, P11 |
| M14 | AI layer: scoring, NBA, summaries, drafting, deal risk, NL reports, assistant, agents | — | ✅ | P07 |
| M15 | Workflow automation builder | — | ✅ | P08 |
| M16 | Approval processes | — | ✅ | P09 |
| M17 | Products, price books, quotes (PDF), discount approvals | — | ✅ | P09 |
| M18 | Contracts, orders, invoicing handoff | — | ✅ | P09 |
| M19 | Forecasting | — | ✅ | P10 |
| M20 | Quotas, leaderboards, gamification, TV wallboards | — | ✅ | P10 |
| M21 | Data management: dedupe/merge, mass update/transfer, recycle bin, export, GDPR tooling | ✅ partial (recycle bin, mass update) | ✅ full | P02, P05, P12 |
| M22 | Billing, plans, entitlements (Stripe) | ✅ | + usage metering (AI credits, API) | P05, P07 |
| M23 | Public API, API keys, webhooks, OAuth connected apps, bulk API, SDK | ✅ API keys + REST | + outbound webhooks (P08), OAuth apps, bulk API, SDK | P03, P08, P12 |
| M24 | Notifications (in-app, email, push via PWA) | ✅ in-app + email | + web push, digests | P04, P12 |
| M25 | Global search and command palette | ✅ | + search-engine adapter at scale | P00, P02, P12 |
| M26 | Audit log, field history, setup audit trail, login history | ✅ | + SIEM streaming | P01–P02, P12 |
| M27 | PWA / mobile-optimised layouts | ✅ responsive | ✅ installable, offline read of recent records, push | P12 |
| — | Customer Support Cases (service module) | ✖ | ✖ **v2** | — |

### 2.2 Explicitly out of scope for v1
Service/cases module; marketing automation (email campaigns at scale, nurture journeys, landing-page builder); predictive auto-dialer (only preview and progressive dialing in v1, because of regulatory exposure); native mobile apps; Arabic UI translation (the architecture must be ready for it); GraphQL API; e-signature (interface stubbed only); CPQ configuration rules such as bundles and constraint engines; marketplace for third-party apps (OAuth connected apps are in scope, a public listing marketplace is not); tenant colour theming.

---

## §3. ARCHITECTURE

### 3.1 System context
```
                    ┌──────────────────────── Global control plane ────────────────────────┐
 Browser/PWA ──►  Vercel: apps/web (Next.js)  ──►  control-api (tenant directory, auth routing, billing webhooks)
     │                    │ BFF route handlers                          │
     │                    ▼                                             ▼
     │         https://{region}.api.salesmaker.app  ◄── region lookup by tenant slug ──┘
     │                    │
     │   ┌────────────── Regional cell (one per data-residency region) ──────────────┐
     └──►│ ALB → apps/api (NestJS, Fastify)  ⇄ Redis (cache, rate limit, BullMQ, pub/sub) │
         │            │                           ▲                                   │
         │            ▼                           │                                   │
         │   PostgreSQL 16 (primary + read replica) ◄── apps/worker (BullMQ consumers)│
         │            │                                  │  imports, assignment, sync,│
         │   S3 bucket (files, recordings links, exports)│  AI jobs, automation, hooks│
         │   Search adapter (Postgres FTS → OpenSearch)  │                            │
         │   apps/realtime (WebSocket gateway, Redis adapter)                         │
         │   apps/ml (optional, Python FastAPI: predictive scoring models, P07)       │
         └────────────────────────────────────────────────────────────────────────────┘
 External: Stripe · Anthropic Claude API · Voyage (embeddings) · Twilio (Voice/SMS) · Meta WhatsApp Cloud API ·
           Google (OAuth, Gmail, Calendar) · Microsoft (Entra ID, Graph mail/calendar) · Meta Lead Ads · LinkedIn Lead Gen ·
           Speech-to-text provider (Deepgram default) · SES/Postmark (transactional + inbound email) · Sentry · OTel backend
```

### 3.2 Technology stack (pin exact latest-stable versions in P00 and record in ADR-0002)
| Layer | Choice | Notes |
|---|---|---|
| Monorepo | **Turborepo + pnpm workspaces** | Remote cache on Vercel |
| Language | **TypeScript (strict)** everywhere; Python only in `apps/ml` | `"strict": true, "noUncheckedIndexedAccess": true` |
| Runtime | **Node.js current LTS** | Same major version in CI, Docker and Vercel |
| Web | **Next.js (latest stable, App Router), React 19** | RSC for shell and data pages, client components for interactive grids and builders |
| UI | **Tailwind CSS v4 + shadcn/ui + Radix Primitives**, wrapped as `@sm/ui` | Tokens as CSS variables (§9) |
| Data fetching | **TanStack Query** (server state), **nuqs** (URL state), **Zustand** (minimal local UI state) | |
| Tables | **TanStack Table + TanStack Virtual** | Virtualised grids for 10k+ rows in view |
| Forms | **React Hook Form + zod** | Dynamic form renderer driven by layout metadata |
| DnD / canvas | **dnd-kit** (Kanban, dashboard grid, layout editor), **React Flow (xyflow)** (automation builder) | |
| Charts | **shadcn charts (Recharts)** for dashboards; **Apache ECharts** allowed for heavy series (>5k points) | Chart colours from §9 tokens only |
| API | **NestJS (Fastify adapter)** | Modular monolith; module boundaries enforced by lint rules |
| Validation / contracts | **zod** schemas in `@sm/contracts` → **OpenAPI 3.1** generated | Same schemas in web and api |
| ORM / SQL | **Prisma** (schema, migrations, platform tables) + **Kysely** (Query Engine, dynamic metadata SQL) | ADR-0004 |
| DB | **PostgreSQL 16** (RDS Multi-AZ), extensions: `pgcrypto`, `pg_trgm`, `citext`, `pgvector`, `btree_gin`, `pg_partman` | Declarative partitioning for activities, history, audit |
| Cache / queues | **Redis 7 (ElastiCache) + BullMQ** | Per-tenant fairness groups |
| Realtime | **WebSocket gateway (NestJS + ws/Socket.IO) with Redis adapter** | Invalidation events only, never full records |
| Files | **S3** (MinIO locally), pre-signed URLs, AV scanning (ClamAV worker) | |
| Search | `SearchProvider` interface: **Postgres FTS + pg_trgm** (MVP) → **OpenSearch** adapter (P12) | |
| Email (system) | **AWS SES** outbound + **inbound parsing** (SES receiving → S3 → worker), **React Email** templates | |
| PDF | **Playwright (Chromium) HTML → PDF** in worker | Quotes, report exports |
| Auth libs | `argon2` (argon2id), `openid-client`, `@node-saml/node-saml`, `otplib`, `@simplewebauthn/server` | In-house auth (§6.1) |
| Observability | **OpenTelemetry** (traces, metrics), **pino** logs, **Sentry** (FE + BE) | `tenant_id`, `user_id`, `request_id` on every span and log |
| Testing | **Vitest** (unit), **Vitest + Testcontainers Postgres/Redis** (integration), **Playwright** (e2e + visual), **k6** (load), **axe-core** (a11y) | |
| IaC | **Terraform** (AWS), Vercel project config in repo | |
| CI/CD | **GitHub Actions** | §13.5 |

### 3.3 Monorepo layout (full tree in `REPO_SCAFFOLD.md`)
`apps/web`, `apps/api`, `apps/worker`, `apps/realtime`, `apps/control-api`, `apps/ml` (P07, optional), `packages/ui`, `packages/contracts`, `packages/db`, `packages/query-engine`, `packages/permissions`, `packages/metadata`, `packages/formula`, `packages/ai`, `packages/i18n`, `packages/emails`, `packages/sdk`, `packages/config`, `packages/testing`, `infra/terraform`, `docs/`.

### 3.4 Regional cells and data residency
- A **cell** is a complete regional stack (API, workers, realtime, Postgres, Redis, S3, search) in one AWS region. Tenant data **never leaves its cell**, except aggregated, non-personal billing and usage counters sent to the control plane.
- Launch regions: **us-east-1 (US)**, **eu-central-1 (EU)**, **me-central-1 (UAE, serving GCC)**, **ap-south-1 (India)**. MVP runs **one cell (eu-central-1)**, but all code is cell-aware from P00: the cell base URL comes from the tenant directory and is never hard-coded.
- **Control plane** (`apps/control-api`, its own small Postgres): tenant directory (`tenant_id, slug, region, status, plan`), global user-email → tenant routing for login, Stripe webhooks, and plan entitlements. It holds **no CRM data**.
- Web (Vercel, global) resolves `{slug}.salesmaker.app` → region → calls `https://{region}.api.salesmaker.app`. Cookies are scoped per tenant subdomain.
- Enterprise tenants can later be placed on a **dedicated cell**. The design must not prevent this: no cross-cell joins, and all tenant-scoped config lives in the cell.

### 3.5 Tenancy and row-level security (implementation contract)
- Every tenant-owned table has `tenant_id uuid NOT NULL` as the **first column of its primary key or of a composite unique index**, and every secondary index leads with `tenant_id`.
- Migration helper `enable_tenant_rls('<table>')` runs:
  ```sql
  ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
  ALTER TABLE <t> FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON <t>
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
  ```
- DB roles: `sm_migrator` (owner, DDL, used only by migrations), `sm_app` (runtime, **not** owner, **no** `BYPASSRLS`), `sm_readonly_reports` (read replica, RLS applies), `sm_support` (break-glass, audited, time-boxed).
- The Prisma client is wrapped in a **client extension** (`withTenant(tenantId, fn)`) that opens an interactive transaction, calls `set_config('app.tenant_id', …, true)` and `set_config('app.user_id', …, true)`, then runs `fn`. Kysely uses the same connection within the transaction. PgBouncer runs in **transaction mode**, which is compatible because `set_config(..., true)` is transaction-local.
- **CI gate `db:rls-audit`:** a script queries `pg_class`/`pg_policies` and fails if any table with a `tenant_id` column lacks forced RLS and the `tenant_isolation` policy. Allow-list only for control-plane or global tables such as `currency`.
- **Cross-tenant test suite:** for every resource endpoint, a generated integration test creates tenants A and B, writes as A, and asserts B gets 404 (never 403, so existence is not leaked) on read, update, delete, list, search, report, export and webhooks.
- RLS enforces **tenant isolation only**. Record-level visibility inside a tenant (sharing) is enforced by the Permission Engine through the Query Engine (§6.4), because pushing per-user sharing into RLS is too slow at 5M records.

### 3.6 Request lifecycle (API)
`Fastify` → request-id → rate limiter (Redis token bucket, per tenant and per user, limits from plan) → auth guard (session JWT or API key or OAuth token) → **TenantContext** (from token, verified against the cell) → **UserContext** (profile, permission sets, org unit, territories, and cached effective permissions) → zod validation → controller → service → RecordService / QueryEngine → response serializer (**FLS stripping**) → problem+json errors (RFC 9457). Every request emits an OTel span with `tenant.id`, `user.id`, `route`, and `db.statement.count`.

### 3.7 RecordService (the only write path for CRM objects)
Pipeline for `create | update | delete | undelete | merge | convert`:
1. Load object and field metadata (cached per tenant, invalidated by metadata version bump).
2. **Object permission** check (create/edit/delete) and **record access** check (edit requires Read/Write share).
3. **FLS write check**: reject writes to non-editable fields with a 403 that lists the fields.
4. Apply **defaults**, **auto-numbers**, and **before-save automation** (field updates only, synchronous, bounded to 50 ms).
5. **Validation rules** (formula expressions, §5.5) and **duplicate rules** (block or warn) → 422 with field-keyed errors.
6. **Optimistic concurrency**: `version` must match; otherwise 409 with the current record.
7. Persist within the tenant transaction. Write **field history** rows for tracked fields and an **audit log** entry.
8. Write **outbox events** (`record.created`, `record.updated` with changed fields, `stage.changed`, `owner.changed`, …) **in the same transaction**.
9. After commit: the outbox relay publishes to BullMQ → search indexer, sharing recalculation, after-save automations, webhooks, AI signals, realtime invalidation.
Bulk operations use the same pipeline in batches of 200 with per-row results.

### 3.8 Query Engine (the only read path for CRM lists, search, reports and AI)
- Input: a JSON **SMQ** (SalesMaker Query) AST validated by zod:
  `{ object, fields[], where: FilterTree, orderBy[], limit (≤ 200 UI, ≤ 2000 API), cursor, groupBy?, aggregates?, include?: relatedObjects[] }`
- Output: Kysely SQL with (1) tenant scope (RLS as a backstop), (2) **sharing predicate** for the current user (§6.4), (3) **FLS projection**, (4) keyset pagination, (5) type-safe filters on standard columns and on `custom` JSONB (with expression indexes where configured).
- Used by list views, Kanban, related lists, global search post-filtering, reports (with aggregate mode, run on the **read replica**), exports, the public API `POST /v1/query`, and AI tools. There is **no other path**.
- Guards: statement timeout 5 s interactive and 60 s async; max 3 levels of relationship traversal; `EXPLAIN` sampling logged for p95 regressions.

### 3.9 Events, jobs and fairness
- **Transactional outbox** table `outbox_event` (partitioned daily, 7-day retention). The relay uses `FOR UPDATE SKIP LOCKED` polling plus `LISTEN/NOTIFY` wake-ups.
- BullMQ queues: `index`, `sharing`, `automation`, `assignment`, `import`, `export`, `email-sync`, `messaging`, `telephony`, `ai`, `webhooks-out`, `reports`, `pdf`, `billing`, `maintenance`. Each job carries `tenantId`. Use **BullMQ group/rate-limit keys per tenant** so one tenant's 1M-row import cannot starve others.
- Retries: exponential backoff; dead-letter queue with an admin UI in Setup → Jobs.

### 3.10 Caching
Per-tenant metadata cache (Redis + in-process LRU, keyed by `metadataVersion`). Effective-permission cache per user (keyed by `permVersion`, bumped on any profile, permset, group or hierarchy change). **No caching of record data** beyond TanStack Query on the client.

### 3.11 Realtime
The WebSocket server authenticates with a short-lived ticket and joins rooms `tenant:{id}`, `user:{id}`, `record:{object}:{id}`, `board:{pipelineId}`, `wallboard:{teamId}`. It sends **invalidation events** (`{type:"record.updated", object, id, version, byUserId}`), and clients refetch through the API so permissions are always re-applied.

### 3.12 Files
Uploads use pre-signed PUT to `s3://sm-{region}-files/{tenantId}/{yyyy}/{mm}/{uuid}`. A worker runs AV scanning before a file becomes downloadable. Max 25 MB per file (plan-configurable). Download is only via short-lived pre-signed GET after an access check on the parent record.

---

## §4. DOMAIN MODEL

### 4.1 Conventions (all tenant tables)
`id uuid` (**UUIDv7**, time-sortable) · `tenant_id uuid` · `created_at timestamptz` · `created_by uuid` · `updated_at` · `updated_by` · `version int` (optimistic lock) · `deleted_at timestamptz null` (soft delete → recycle bin, hard purge after 30 days) · CRM objects also have `owner_id uuid` (user or queue), `record_number text` (auto-number, e.g. `L-000123`), `custom jsonb` (custom field values), `search_vector tsvector` (generated), `external_id text` (unique per tenant per object, for upserts), `record_type_id`.
Money columns: `amount numeric(18,2)`, `currency_code char(3)`, `amount_corporate numeric(18,2)` (converted at the dated rate).

### 4.2 Entity catalogue (≈130 tables; Claude Code produces the full ERD in P00/P02 as `docs/spec/ERD.md` with Mermaid)
**Control plane:** `cp_tenant`, `cp_tenant_domain`, `cp_user_routing`, `cp_subscription`, `cp_plan`, `cp_entitlement`, `cp_usage_counter`, `cp_stripe_event`.
**Tenant and settings:** `tenant_settings` (locale defaults, corporate currency, fiscal year, business hours, logo), `currency_rate` (dated), `fiscal_period`, `business_hours`, `holiday`, `feature_flag`.
**Identity:** `user`, `user_identity` (password, google, microsoft, saml, oidc), `session`, `refresh_token`, `mfa_factor`, `passkey`, `invitation`, `login_history`, `api_key`, `oauth_client`, `oauth_grant`, `sso_connection`, `scim_token`.
**Hierarchy and access:** `org_unit` (tree) + `org_unit_closure`, `user.org_unit_id`, `user.manager_id`, `profile`, `permission_set`, `permission_set_group`, `permission_set_group_member`, `permission_assignment`, `object_permission`, `field_permission`, `system_permission`, `public_group`, `group_member`, `queue`, `queue_member`, `queue_object`, `org_wide_default`, `sharing_rule`, `record_share` (per object, partitioned by object), `account_team_member`, `opportunity_team_member`, `user_visibility_closure` (materialised owner set per user), `territory_model`, `territory` + `territory_closure`, `territory_user`, `territory_rule`, `record_territory`.
**Metadata:** `object_definition`, `field_definition`, `picklist_value`, `picklist_dependency`, `record_type`, `record_type_picklist`, `page_layout`, `layout_assignment`, `compact_layout`, `list_view`, `validation_rule`, `matching_rule`, `duplicate_rule`, `relationship_definition`, `report_type`, `path_setting` (stage guidance), `field_history_setting`, `auto_number_sequence`.
**Core CRM:** `lead`, `account`, `contact`, `account_contact_relation`, `opportunity`, `opportunity_contact_role`, `opportunity_stage_history`, `pipeline`, `pipeline_stage`, `campaign`, `campaign_member`, `lead_conversion`, `custom_record` (all custom objects, §5.2), `tag`, `record_tag`, `favorite`, `recent_item`.
**Activity and communication:** `activity` (**partitioned monthly** by `created_at`; `type ∈ {task, call, meeting, email, whatsapp, sms, note, system}`), `activity_link` (what/who polymorphic links), `task_detail`, `call_detail`, `meeting_detail`, `email_message`, `email_thread`, `message` (WhatsApp/SMS), `attachment`, `calendar_event`, `channel_connection`, `message_template`, `consent_record`, `transcript`.
**Capture, routing and scoring:** `web_form`, `web_form_field`, `web_form_submission`, `inbound_email_address`, `import_job`, `import_row_result`, `assignment_rule`, `assignment_rule_entry`, `assignment_pool_member`, `round_robin_cursor`, `user_capacity`, `user_availability`, `sla_policy`, `sla_timer`, `scoring_model`, `scoring_rule`, `record_score`, `score_history`, `lead_ads_connection`.
**Telesales:** `telephony_config`, `dialer_list`, `dialer_list_member`, `dialer_session`, `call_disposition`, `disposition_action`, `dnc_entry`, `agent_state_event`, `callback`, `calling_window_policy`.
**Revenue:** `product`, `product_family`, `price_book`, `price_book_entry`, `opportunity_line_item`, `quote`, `quote_line_item`, `quote_template`, `contract`, `order`, `order_item`, `invoice_handoff`, `integration_connection`.
**Automation and approvals:** `flow`, `flow_version`, `flow_trigger`, `flow_run`, `flow_step_log`, `scheduled_flow_action`, `approval_process`, `approval_step`, `approval_request`, `approval_work_item`, `approval_history`, `outbox_event`, `webhook_subscription`, `webhook_delivery`.
**Performance:** `forecast_type`, `forecast_submission`, `forecast_adjustment`, `forecast_snapshot`, `quota`, `quota_period_rollup`, `leaderboard`, `badge`, `badge_award`, `streak`, `wallboard`.
**Analytics:** `report_folder`, `report`, `report_run`, `report_subscription`, `dashboard`, `dashboard_component`, `dashboard_filter`, `metric_rollup_daily` (pre-aggregated).
**AI:** `ai_usage_event`, `ai_prompt_template` (versioned), `ai_insight` (NBA, risk, summary), `ai_agent_definition`, `ai_agent_run`, `ai_proposed_action`, `embedding` (pgvector), `ai_feedback`.
**Governance:** `audit_log` (**append-only, hash-chained, partitioned monthly**), `field_history` (**partitioned monthly**), `setup_audit`, `recycle_bin_item`, `data_export_job`, `dsar_request`, `retention_policy`, `notification`, `notification_preference`, `job_run`, `support_access_grant`.

### 4.3 Lead lifecycle (state machine; statuses are admin-configurable but must map to these system categories)
```
New ──► Working ──► Qualified ──► [Convert] ──► Converted (read-only)
  │        │  ▲          │
  │        ▼  │          └──► Unqualified (reason required) ──► Recycled → New (after N days, rule-driven)
  └──► Nurturing ◄───────┘
```
- System categories: `OPEN`, `WORKING`, `NURTURE`, `QUALIFIED`, `UNQUALIFIED`, `CONVERTED`. Reports and AI use categories; admins rename labels freely.
- **First-touch SLA** starts at assignment; the timer pauses outside the owner's business hours if the policy says so.

### 4.4 Lead conversion (Salesforce model)
Convert Lead → **Account** (create new, or match existing by duplicate rules) + **Contact** (create new, or match existing) + optional **Opportunity** (name default `{Company} – {Product interest}`, pipeline and stage from the lead's record type). Admin-defined **field mapping** covers standard and custom fields, including a type-compatibility check. Activities, campaign memberships and attachments re-parent to the Contact (and link to the Opportunity). The lead becomes `CONVERTED`, read-only, with links to the created records. It is one transaction through RecordService; it is **undoable within 24 hours** if the created records are untouched.

### 4.5 Opportunity model
Fields: name, account, primary contact, pipeline, stage, probability (defaults from stage, overridable if the permission allows), **forecast category** (`PIPELINE`, `BEST_CASE`, `COMMIT`, `CLOSED`, `OMITTED`; defaults from stage), amount (sum of line items if products exist, otherwise manual), currency, close date, next step, lead source, campaign, loss reason (required on Closed Lost), competitor(s), type (New, Upsell, Renewal), owner, team, contact roles. `opportunity_stage_history` records every stage, amount, close-date and forecast-category change for velocity and slippage analytics.

### 4.6 Account / Contact
Accounts form hierarchies (`parent_account_id`, with cycle prevention). Contacts can relate to multiple accounts (`account_contact_relation`). Consent flags per channel per contact live in `consent_record` (source, timestamp, lawful basis).

---

## §5. METADATA AND CUSTOMISATION ENGINE

### 5.1 Objects
Standard objects (Lead, Account, Contact, Opportunity, Campaign, Product, Quote, Contract, Order, Activity) are real tables with typed columns. Admins can add **custom fields** to any standard object and create **custom objects**. Every object has `object_definition` metadata: `api_name` (`lead`, `account`, `project__c`), labels (singular/plural, i18n keys), icon, colour token, sharing model (OWD), record name format (text or auto-number), and enabled features (activities, history, search, reports, API).

### 5.2 Custom objects storage
One table, `custom_record(tenant_id, object_def_id, id, name, owner_id, record_type_id, data jsonb, …standard columns)`, partitioned by **hash of tenant_id** (16 partitions). Filterable custom fields marked **"indexed"** by the admin get **partial expression indexes** created by an async DDL job (`CREATE INDEX CONCURRENTLY … ON custom_record ((data->>'fld_x')) WHERE tenant_id = … AND object_def_id = …`), capped per tenant by plan. The same jsonb + expression-index strategy applies to `custom` columns on standard objects.

### 5.3 Field types
Text, Text Area, Long Text, Rich Text (sanitised HTML), Email, Phone (stored as E.164 plus raw), URL, Number(p,s), Currency, Percent, Date, DateTime, Time, Checkbox, Picklist (with global value sets, dependent picklists and per-record-type values), Multi-Select Picklist, Lookup, Master-Detail (cascade delete and roll-ups; controlled-by-parent sharing), Auto-Number, **Formula** (read-only, computed on read for simple cases, persisted if referenced by filters), **Roll-Up Summary** (COUNT/SUM/MIN/MAX on master-detail children, maintained asynchronously with nightly reconciliation), Geolocation, and User.
Limits per object: 500 custom fields (plan-limited), 40 lookup fields, 25 roll-up fields.

### 5.4 Layouts and record types
- **Page layout:** sections (1 or 2 columns), fields (required or read-only at layout level), related lists (columns, sort), and actions (buttons). Assigned per profile × record type.
- **Compact layout:** up to 7 highlight fields shown in the record Highlights Panel and on Kanban cards.
- **Record types:** different pipelines (for opportunities), picklist values and layouts per business process.
- **Path settings:** per stage, "key fields" and "guidance for success" (rich text) shown in the Path component.
- **List views:** filter tree, columns, sort, sharing (private / groups / all), pinned default per user.

### 5.5 Expression language (`@sm/formula`)
One safe language for formula fields, validation rules, automation conditions, assignment criteria, approval entry criteria and scoring rules.
- Types: Text, Number, Currency, Percent, Boolean, Date, DateTime, Picklist, Null.
- Operators: `+ - * / ^ & = != < <= > >= && || !`.
- Functions (v1): `IF, CASE, AND, OR, NOT, ISBLANK, BLANKVALUE, ISCHANGED, PRIORVALUE, ISNEW, ISPICKVAL, INCLUDES, TEXT, VALUE, LEN, LEFT, RIGHT, MID, CONTAINS, BEGINS, UPPER, LOWER, TRIM, SUBSTITUTE, REGEX, ROUND, FLOOR, CEILING, ABS, MIN, MAX, MOD, TODAY, NOW, DATE, DATEVALUE, YEAR, MONTH, DAY, WEEKDAY, ADDMONTHS, DATEDIFF, BUSINESSDAYS, $User.*, $Org.*`. Cross-object references are allowed up to 5 relationship hops (`Account.Owner.Name`).
- Implementation: a hand-written Pratt parser → typed AST → type checker (errors shown in the editor with position) → evaluator in TS. A **SQL compiler** for the subset used in filters, so formula fields can be filtered in the Query Engine. Fuzz tests and 300+ unit cases.

### 5.6 Metadata versioning and deployment
Every metadata change bumps `tenant_settings.metadata_version`, writes `setup_audit` (before/after JSON diff), and invalidates caches. **Sandboxes are out of scope for v1**, but metadata must be exportable and importable as JSON (`GET/POST /v1/metadata/package`) so a sandbox or promotion flow can be added later.

---

## §6. SECURITY AND ACCESS MODEL

### 6.1 Authentication
- **Password:** argon2id (memory 64 MB, iterations 3, parallelism 1); breached-password check via k-anonymity range API; min 12 chars; lockout after 10 failures in 15 minutes with exponential backoff.
- **Social SSO:** Google and Microsoft (OIDC), with just-in-time linking only to an **existing invited** user of the tenant (no auto-join by email domain unless the admin enables a verified domain).
- **Enterprise SSO (P12):** SAML 2.0 and generic OIDC per tenant, with an "enforce SSO" option, JIT provisioning with attribute → profile/org-unit mapping, and **SCIM 2.0** for provisioning and deprovisioning.
- **MFA:** TOTP and WebAuthn/passkeys; admins can enforce it per profile; recovery codes.
- **Sessions:** access JWT (15 min, EdDSA, `kid` rotation) + rotating refresh token (httpOnly, Secure, SameSite=Lax, 30 days sliding, reuse detection revokes the chain). Session list and remote sign-out in user settings. Admin-set session timeout, **login IP ranges** and **login hours** per profile.
- **API keys:** tenant-scoped, prefixed `sm_live_` / `sm_test_`, stored hashed, scoped to a run-as integration user, with an expiry, last-used tracking and rotation.
- **OAuth 2.0 (connected apps, P12):** authorization code + PKCE, refresh tokens, and scopes (`records:read`, `records:write`, `metadata:read`, `reports:read`, `webhooks:manage`, …).

### 6.2 Authorisation layers (evaluated in this order; all must pass)
1. **Tenant** (RLS).
2. **System permissions** (profile ∪ permission sets): e.g. `manage_users`, `customize_application`, `view_setup`, `import_records`, `export_reports`, `mass_update`, `transfer_records`, `run_reports`, `manage_dashboards`, `api_enabled`, `view_all_data`, `modify_all_data`, `manage_billing`, `use_ai_assistant`, `approve_ai_actions`, `manage_automations`, `manage_territories`, `view_wallboard`, `bypass_calling_window` (default nobody).
3. **Object permissions** (profile ∪ permission sets): Read, Create, Edit, Delete, View All, Modify All, per object.
4. **Record access** (sharing, §6.3–6.4): None / Read / Read-Write / Full (owner-equivalent: transfer, share, delete).
5. **Field-level security**: Hidden / Read / Edit per field (profile ∪ permission sets; most permissive wins).
Permission sets are **additive only**; there are no deny rules in v1. Permission set groups bundle sets, with an optional **muting set** (a single subtractive exception, like Salesforce).

### 6.3 Record sharing model
- **Org-wide defaults (OWD)** per object: `PRIVATE`, `PUBLIC_READ`, `PUBLIC_READ_WRITE`, `CONTROLLED_BY_PARENT` (Contact→Account, Opportunity→Account optional, master-detail children). Defaults: Lead `PRIVATE`, Account `PRIVATE`, Contact `CONTROLLED_BY_PARENT`, Opportunity `PRIVATE`, Activity `CONTROLLED_BY_PARENT`, Campaign `PUBLIC_READ`, Product `PUBLIC_READ`.
- **Hierarchy access:** users see and edit records owned by users in **descendant org units** (and their direct reports via `manager_id`) when "grant access using hierarchies" is on for the object (on by default, can be turned off for custom objects).
- **Sharing rules:**
  - owner-based: records owned by members of group, role, role+subordinates or territory X → shared with Y at Read or Read-Write;
  - criteria-based: records matching a filter → shared with Y.
- **Queues:** members of a queue see records owned by the queue.
- **Teams:** account team and opportunity team members get the access level set on the membership.
- **Manual sharing:** owners (or users with Full access) share a record with a user or group.
- **Territories (P10):** users assigned to a territory (and managers of ancestor territories) get the access level configured on the territory model for accounts in it, and for that account's opportunities and contacts, per territory model settings.
- `View All` / `Modify All` (object) and `view_all_data` / `modify_all_data` (system) bypass sharing.

### 6.4 Sharing computation (performance-critical; the design is fixed)
- **Principal sets.** For each user, precompute `principals(user)` = {user, public groups (transitive), queues, org units + ancestors-for-role-rules, territories} and cache it in Redis (bumped by `permVersion`).
- **Owner visibility closure.** `user_visibility_closure(tenant_id, viewer_user_id, owner_id)` is materialised: for each viewer, all owners in their subordinate subtree + themselves + queues they belong to. It is recomputed incrementally by the `sharing` queue when org units, managers or queue membership change. At 1,000 users the worst case is ~500k rows per tenant, which is acceptable.
- **Explicit shares.** `record_share(tenant_id, object, record_id, principal_type, principal_id, access, reason ∈ {RULE, MANUAL, TEAM, TERRITORY, IMPLICIT_PARENT, IMPLICIT_CHILD}, rule_id)` is partitioned by object. Sharing rules are evaluated asynchronously on record create/update and on rule change, via a batched recalculation job with progress shown in Setup.
- **Query predicate** injected by the Query Engine for a PRIVATE object:
  ```sql
  ( r.owner_id IN (SELECT owner_id FROM user_visibility_closure WHERE tenant_id=$t AND viewer_user_id=$u)
    OR EXISTS (SELECT 1 FROM record_share s WHERE s.tenant_id=$t AND s.object=$o AND s.record_id=r.id
               AND s.principal_id = ANY($principals) AND s.access >= $needed) )
  ```
  with indexes `(tenant_id, owner_id, …)` on objects and `(tenant_id, object, principal_id, record_id)` on `record_share`.
- **Sharing-lag guarantee:** rule-based shares converge in < 60 s p95 for single-record changes. Owners and hierarchy see their records immediately because the closure is synchronous for ownership.
- **Test fixture:** the 800-rep demo tenant (§15) is the performance fixture; list-view p95 must stay within §11 budgets with sharing on.

### 6.5 FLS enforcement points (every one is mandatory and tested)
Query Engine projection · API serializer · RecordService writes · global search results (hidden fields are neither searchable nor highlighted) · reports (hidden columns and filters are rejected) · exports · list-view columns · Kanban card fields · email/WhatsApp merge fields · AI context builders (§8.9) · webhooks (payload fields filtered by the subscription owner's FLS) · audit/history viewers (hidden-field history is masked).

### 6.6 Data protection
TLS 1.2+ everywhere and HSTS; AES-256 at rest (RDS, S3, Redis) with KMS keys per cell; **application-level envelope encryption** for secrets (OAuth tokens for Gmail/Graph, WhatsApp tokens, SSO certificates, API credentials) in `pgcrypto`-backed columns with key IDs; optional per-field **encrypted custom fields** (not filterable, masked in lists). CSP with nonces, CSRF protection for cookie auth, SSRF protection on outbound webhooks (block private IP ranges, re-resolve DNS), and rich-text sanitisation (DOMPurify server-side).

### 6.7 Support access
Staff cannot see tenant data by default. An org admin grants **time-boxed support access** (1–72 h), which is logged in `support_access_grant`, and every support read is written to the tenant's audit log, visible to the admin.

---

## §7. MODULE SPECIFICATIONS (functional requirements; each phase prompt expands its modules into tasks)

### 7.1 Lead capture (M6)
- **CSV / XLSX import wizard** (up to 1M rows per job): upload → sheet pick → header detection → **field mapping** (auto-match by label, synonyms and previous mappings; saveable mapping templates) → value transforms (picklist value mapping, date format, phone country default, owner by email or name, currency) → **duplicate handling** (skip / update matched / create anyway, using the matching rules) → **dry run** with a 100-row preview and projected errors → async execution with a progress bar → result file (success IDs + error rows with reasons, downloadable) → **undo import** within 72 h (soft-deletes records created by the job). Assignment rules optionally run on import.
- **Web-to-lead forms:** builder (fields from Lead metadata, required flags, hidden fields, default values, picklist subsets, consent checkboxes with text), styling from design tokens (light/dark/auto) with customisable button label, thank-you message or redirect URL. Delivered as an **embeddable JS snippet**, iframe and hosted page `forms.salesmaker.app/{tenant}/{form}`. **Spam defence:** Cloudflare Turnstile (optional), honeypot, per-IP rate limit, disposable-email check. Automatic **UTM, referrer, landing page and gclid/fbclid capture**; campaign attribution; per-form assignment rule and auto-responder email.
- **REST API:** `POST /v1/records/lead` and upsert by `external_id`; bulk API (§10.4).
- **Email-to-lead:** per-tenant inbound addresses (`leads-{token}@in.salesmaker.app`), parsing the sender, signature block (AI-assisted in P07) and body into a Lead with the raw email attached. If the sender matches an existing lead or contact, log an activity instead.
- **WhatsApp inbound (P06):** a new conversation from an unknown number creates a Lead (source=WhatsApp); a known number logs to the timeline.
- **Meta Lead Ads + LinkedIn Lead Gen Forms (P06):** OAuth connection, page/form picker, field mapping, webhook (Meta) or polling (LinkedIn) ingestion, and a backfill of the last 90 days.
- Every capture path sets `lead_source`, `lead_source_detail`, `campaign_id` (if resolvable) and `captured_via`, and runs **duplicate rules** and **assignment rules**.

### 7.2 Duplicate management (M7)
- **Matching rules:** field comparisons (exact, fuzzy with `pg_trgm` similarity threshold, normalised phone E.164, email domain + name, company name normalisation that strips legal suffixes such as LLC, Ltd, W.L.L., FZ-LLC, GmbH, S.A.).
- **Duplicate rules:** on create/edit, per object → **Block** or **Alert** (show the potential duplicates panel), with bypass for chosen profiles.
- **Merge:** 2–3 records; field-by-field winner selection; children re-parented; loser soft-deleted with a `merged_into_id`; history kept.
- **Duplicate jobs:** scheduled tenant-wide scans producing a review queue.

### 7.3 Assignment, queues, SLA and territories (M7)
- **Assignment rules** (per object: Lead, Opportunity, custom): ordered entries, each with **criteria** (filter tree or formula) → **method**:
  - `ROUND_ROBIN` over a pool (users, queue members, org unit members), skipping unavailable users (out of office, outside hours, agent state Away, at capacity);
  - `WEIGHTED` (percent shares);
  - `LOAD_BALANCED` (fewest open records of a status category);
  - `SKILLS_BASED` (user skill tags ∩ required tags, e.g. language, product, region; tie-break by load);
  - `TERRITORY` (owner from the account/lead territory's assigned users, using the chosen method within the territory);
  - `STICKY_ACCOUNT` (existing account owner if the lead's company matches an account);
  - `QUEUE` (park in a queue for pick-up);
  - `SPECIFIC_USER`.
- **Capacity:** per user per object (max open, max new per day). **Availability:** working hours from the user's timezone and calendar, OOO flag, agent state (P06).
- Deterministic and auditable: every assignment writes an `assignment_log` (rule, entry, method, candidates considered, reason chosen) that is visible on the record ("Why was this assigned to me?").
- **SLA policies:** time to first touch (first call/email/WhatsApp logged), time to qualify. Business-hours aware. Escalation ladder: notify owner at 50%, notify manager at 100%, **auto-reassign** at X% (optional) via a chosen rule. SLA status chip on records and list views, plus a breach report.
- **Lead recycling:** Unqualified/Nurture leads return to New and are re-routed after N days, by criteria.
- **Queues:** pick-up list view, "Accept" and "Take next" buttons (fetch the highest-priority record and lock it to the user atomically with `SELECT … FOR UPDATE SKIP LOCKED`).
- **Territory management** (P10):
  - multiple **territory models** (one active, others in planning state), each a territory hierarchy with types (Geo, Industry, Named Account, Size);
  - **assignment rules** on Account fields (country, state, city, postal code ranges, industry, employees, revenue, custom) that map accounts to territories, with leads mapped via address and company fields;
  - users are assigned to territories with a role in the territory (Owner, Member, Overlay);
  - access levels per model for accounts, opportunities, contacts and leads;
  - a **"Run assignment"** preview showing the diff (accounts moving in and out) before activation;
  - a territory-based forecasting hook (P10) and territory reports.

### 7.4 Lead scoring (M8)
- **Rules-based (MVP):** Fit score (0–100: firmographic and demographic rules with points, using formula criteria) + Engagement score (0–100: activities, email opens/replies, form submissions, WhatsApp replies, with **time decay**, half-life configurable) → **Grade** (A–D from fit) and **Score** (1–100 combined). Recalculated on relevant events and nightly.
- **AI predictive (P07):** see §8.4. It shows the top positive and negative factors. Admins choose which score drives routing.
- Scores are fields (filterable, sortable, reportable), with history in `score_history`.

### 7.5 Core records UX (M5)
- **Object home = list view** (T1 template): saved views, quick filters, a column chooser, inline edit (double-click or `E`), bulk select (up to 10k via "select all matching", which runs as a job), mass actions (update field, change owner, add to campaign or dialer list, add tag, delete, export), keyboard navigation (`J/K` to move, `Enter` to open, `X` to select), a split-view toggle (list left, record right), and density toggle.
- **Record page** (T2): Highlights Panel (compact layout, owner, key actions), **Path** (stage bar with guidance), tabs **Overview · Activity · Related · History · AI**, and a right rail with the **activity composer** (Log call · Email · WhatsApp · Task · Meeting · Note) plus upcoming items. Inline edit of any field with FLS applied. Mention users with `@` in notes, which sends a notification.
- **Create:** quick-create modal (the required fields from the layout) or full page. Duplicate panel appears live while typing email, phone or company.
- **Related lists** configurable per layout, each with its own "New" action pre-filling the lookup.
- **Recycle bin** (30 days): restore with children.
- **Tags, favourites, recent items** (in the sidebar), and **follow** (subscribe to a record's changes).

### 7.6 Pipelines and Kanban (M9)
- Multiple **pipelines** (sales processes) per org, linked to Opportunity record types. Stages have name, order, probability, forecast category, system type (`OPEN`, `WON`, `LOST`), required fields to enter (**stage gates**, validated by RecordService), and colour token from the categorical palette.
- **Kanban board:** columns per stage with header totals (count, sum amount in the user's currency, weighted amount). Cards use the compact layout (max 4 fields + owner avatar + next activity date + risk badge from P07 + days-in-stage). Drag to move stage (gates open a modal for required fields; Won/Lost open close dialogs). Each column is independently **paged, 50 cards per page, with infinite scroll inside the column**; aggregates come from SQL grouped queries, not client sums. Filters are shared with list views. Swimlanes by owner or close month (optional).
- **Other pipeline views:** list, **forecast grid** (P10), and **pipeline analytics** (conversion rate per stage, average days per stage, slippage).

### 7.7 Activities and calendar (M10)
- Unified **timeline** on every record (own activities + children, e.g. an account shows its contacts' and opportunities' activities), filterable by type, user and date, with pinned items.
- **Tasks:** subject, due date/time, priority, status, reminder, recurrence (RRULE), related to (what) and person (who). "My Tasks" view: Overdue / Today / Upcoming, keyboard-completable.
- **Calls** (manual log in MVP; CTI-powered in P06): direction, outcome/disposition, duration, notes, recording link, and follow-up task creation in the same form.
- **Meetings:** date/time, attendees (users + contacts), location or video link, outcome. **Calendar sync** (P06): Google Calendar + Microsoft 365, two-way for meetings created in SalesMaker and one-way import of external meetings with known contacts.
- **Notes:** rich text, @mentions, pin.
- Activity counts roll up to records (`last_activity_at`, `next_activity_at`, `activity_count_30d`), maintained by the worker and used by scoring, NBA and lists.

### 7.8 Telesales (M11, P06)
- **CTI adapter interface** `TelephonyProvider` with `placeCall`, `hangup`, `hold`, `transfer`, `mute`, `sendDtmf`, `onEvent`, `getRecordingUrl`, `listNumbers`. Default adapter: **Twilio Voice** (WebRTC softphone via Twilio Voice JS SDK). The adapter pattern must make **Amazon Connect, Aircall, Genesys Cloud, 3CX and generic SIP** possible later without touching feature code.
- **Softphone dock** (bottom-right, persistent across navigation, draggable, minimisable): dial pad, current call card showing the matched record, timer, controls, and **disposition picker on hang-up** (required before next). Wrap-up timer is configurable (e.g. 30 s).
- **Click-to-call** on every phone field (respects DNC and calling windows).
- **Dialer lists** (call queues): built from any list view or report, or by assignment. Priority ordering (score, SLA due, callback time). Modes: **Preview** (agent sees the record, clicks Call) and **Progressive/Power** (auto-dials the next record after wrap-up, one line per agent). No predictive dialing in v1.
- **Dispositions:** admin-configurable per list or object (e.g. Connected–Interested, Connected–Not interested, Callback requested, No answer, Busy, Voicemail, Wrong number, Do not call). Each maps to **actions**: set status, schedule callback (a date-time picker appears), create task, add to DNC, remove from list, retry after N hours (max M attempts), and trigger a flow.
- **Agent states:** Available, On call, Wrap-up, Break (reasons), Training, Offline, all logged to `agent_state_event` for productivity reports.
- **Compliance:** tenant **DNC list** + imported national DNC lists (CSV); **calling windows** per recipient's local timezone (derived from phone country/area and address) and per country policy; max attempts per day; **recording consent** announcement option and per-country recording policy; caller ID per region.
- **Recordings:** stored at the provider; SalesMaker keeps **links + metadata**; access is permission-gated (`listen_recordings`) and audited.
- **Wallboard** (T10): live per team: agents by state, calls today, connect rate, talk time, average handle time (AHT), conversions, callbacks due, SLA breaches; TV mode (auto-rotating, large type, dark theme).
- **Call summaries and transcripts:** §8.5.

### 7.9 Channels (M12, P06)
- **Email:** OAuth connect of **Gmail (Gmail API + Pub/Sub push)** and **Outlook (Microsoft Graph + change notifications)**, per user. Two-way sync of messages that involve known leads/contacts (a privacy filter: only matched threads are stored; users can exclude domains). Send from SalesMaker through the user's mailbox. **Templates** with merge fields (FLS-aware), attachments, and a signature. Open and click tracking is **off by default** and tenant-configurable (a privacy regime note in the UI). Bounce handling. Schedule send.
- **WhatsApp:** Meta **WhatsApp Business Cloud API**, tenant connects via **Embedded Signup** (WABA + phone numbers). Inbound webhook → conversation on record, unified inbox view (T7) with assignment to the record owner or a queue. Outbound: **template messages** outside the 24-hour customer service window (template management synced from Meta, approval status shown) and free-form inside it. Media messages (image, document, audio). Opt-in capture and opt-out keywords (STOP) update `consent_record`.
- **SMS:** `SmsProvider` interface, default **Twilio Messaging**, with a second adapter slot for regional providers (e.g. Unifonic for GCC). Two-way, opt-out handling, sender ID per country.
- All messages become `activity` rows, appear on the timeline and feed engagement scoring.

### 7.10 Products, price books, quotes (M17, P09)
- **Products:** code/SKU, name, family, description, active, unit of measure, tax category, custom fields.
- **Price books:** a standard price book plus custom ones (e.g. regional or partner). Entries are per product per currency with list price; a price book is selected per opportunity (defaults by rule).
- **Opportunity products:** quantity, list price, discount %, sales price, line total, and schedule (revenue/quantity schedules deferred to v2). Opportunity amount = Σ line totals when products exist.
- **Quotes:** multiple per opportunity, one "synced" quote. Versioning (v1, v2…), expiry date, billing/shipping addresses, terms, line items copied from the opportunity with independent edits, subtotal, discount, tax lines (manual or tax table), grand total. **Discount approvals:** if any line or header discount exceeds the approval matrix (by % and amount, per profile or team), the quote goes into the approval process (M16) and is locked until approved.
- **Quote PDF:** template builder (sections: header with logo, customer block, line table, totals, terms, signature block) rendered through HTML → PDF (Playwright); preview in the browser; email the quote through the user's mailbox with PDF attached; status flow `Draft → In Review → Approved → Presented → Accepted | Rejected | Expired`.
- **E-signature:** `ESignatureProvider` interface stub only (DocuSign adapter in v2).

### 7.11 Contracts, orders, invoicing handoff (M18, P09)
- **Contract:** account, start date, term (months), end date (computed), status (Draft, Activated, Expired, Terminated), renewal reminder (N days before end → task + optional renewal opportunity created by flow).
- **Order:** created from an **accepted quote** (1-click) or manually. Order items copied from the quote, status (Draft, Activated, Fulfilled, Cancelled); activation locks items.
- **Invoicing handoff:** on order activation → `order.activated` webhook (always) + **adapter** `AccountingProvider` with default adapters **Xero** and **QuickBooks Online** (create contact + invoice), plus a CSV export. `invoice_handoff` tracks status, external IDs and errors, with retry. Payment status can be synced back (webhook from the accounting system) to show "Paid" on the order.

### 7.12 Forecasting (M19, P10)
- **Forecast types:** Opportunity Revenue (amount), Opportunity Quantity (count), Product Family revenue (line items); each by **close-date period** (month or quarter from the fiscal calendar, standard or custom fiscal year).
- **Hierarchy:** the org-unit (role) tree, **or** the territory hierarchy (per forecast type).
- **Categories:** Closed, Commit, Best Case, Pipeline (Omitted excluded). Rollups are cumulative (Commit includes Closed; Best Case includes Commit).
- **Submission:** each rep sees auto-calculated amounts per category. Managers can **adjust** a subordinate's number (their adjustment layer, not the rep's data), with notes. **Submit** freezes a snapshot. The adjustment history is audited.
- **Forecast grid** (T1 variant): rows = hierarchy, columns = periods × categories, drill down to opportunities, with **quota** and **attainment %** and **pipeline coverage (open pipeline ÷ remaining quota)**.
- **Snapshots:** weekly automatic snapshots feed a "forecast trend" chart (how the commit moved over the quarter).

### 7.13 Quotas, leaderboards, gamification (M20, P10)
- **Quotas:** per user or org unit, per period, per metric (revenue won, # won deals, # calls, # connected calls, # meetings held, # leads qualified, custom metric from a report). Import quotas via CSV. Attainment is computed from `metric_rollup_daily`.
- **Leaderboards:** configurable metric, period, scope (team, org unit, company), privacy mode (show only top N plus own rank). Updated in near-real time (≤ 1 min).
- **Gamification:** badges (rules: e.g. "10 connected calls before 11:00", "First deal of the month"), streaks (consecutive days meeting the activity goal), team challenges (time-boxed contests with a target and a live progress bar), celebration moments (confetti on Won, respects `prefers-reduced-motion` and a user toggle), all visible on the Home and Wallboard. Admins can switch gamification off per org unit.

### 7.14 Reports and dashboards (M13)
- **Report types** (metadata): primary object + up to 3 related objects (e.g. Opportunities with Products; Accounts with Contacts; Activities with Leads), including "with or without" joins.
- **Report formats:** Tabular, Summary (up to 3 groupings), **Matrix** (row × column groupings, P11). Aggregates: count, sum, avg, min, max, unique count; **row-level formulas** and **summary formulas** (using `@sm/formula`); bucket fields (P11); relative date filters (THIS_QUARTER, LAST_N_DAYS:30, NEXT_FISCAL_QUARTER, …); cross filters (with/without related records); "My / My team's / All" scope toggles (still bound by sharing).
- **Execution:** SMQ in aggregate mode on the **read replica**. Synchronous when estimated rows < 200k, otherwise an **async run** with notification. Results are cached for 5 minutes per (report, user-permission-hash). Export CSV/XLSX is gated by `export_reports` and audited.
- **Charts:** bar (vertical/horizontal, stacked), line, area, donut, funnel, KPI/metric tile, gauge (vs target), table, leaderboard, scatter (P11), heat-map matrix (P11).
- **Dashboards:** 12-column responsive grid, drag-and-drop layout (dnd-kit), up to 20 components, **dashboard filters** (up to 3, applied to all components), **running user** (static "view as" with permission) **or dynamic** ("as viewer") dashboards, auto-refresh (min 5 min), and full-screen/TV mode.
- **Subscriptions:** schedule reports and dashboards by email (PNG snapshot + CSV link) daily, weekly or monthly, respecting each recipient's access.
- **NL query** (P07): "Show me Q3 deals stuck more than 30 days in Proposal by owner" → the report definition is shown and editable, then run (§8.7).

### 7.15 Workflow automation (M15, P08)
- **Flow builder** (T8, React Flow canvas): the trigger node → a graph of nodes. Autosave drafts; **versioning** (draft, active, inactive); only one active version per flow; runs pin to the version they started on.
- **Triggers:** record created, updated (with "only when specified fields change" and "only when criteria newly met"), created or updated, deleted; **scheduled** (cron, in tenant timezone) over a filtered set of records; **time-relative** (X days before/after a date field, e.g. 3 days before close date); **platform events** (form submitted, email received, WhatsApp received, call ended with disposition X, SLA breached, approval decided, AI insight created, quote accepted); **manual** (button on record, or bulk from list); **inbound webhook** (tenant endpoint with a secret).
- **Logic nodes:** Decision (multi-branch, formula or filter conditions), Wait (duration, until date/time, until condition with timeout), Loop (over a related list, max 500 items), Assignment (set variables), Get Records (via the Query Engine), Sub-flow.
- **Action nodes:** Update record(s), Create record, Delete record, Run assignment rule, Change owner, Add to dialer list / campaign, Send email (template, from user or org address), Send WhatsApp template, Send SMS, Create task, Post in-app notification, @mention on a record, Call outbound webhook (with retries), Submit for approval, Run AI action (summarise, classify, draft, score, and **invoke agent** (proposals go to the approval inbox, §8.10)), Generate quote PDF, Create order.
- **Runtime:** executes in the `automation` queue. **Before-save** flows are field-update only and synchronous in RecordService (≤ 50 ms budget, else rejected at design time). **After-save** flows are async. Each run records inputs, steps, outputs, duration and errors in `flow_run`/`flow_step_log` (retained for 30 days, searchable), with a run-history UI per flow and per record.
- **Safety and limits:** recursion guard (a flow cannot re-trigger itself on the same record within the same transaction chain; max chain depth 5); per-tenant **governor limits** (runs per hour by plan, max 2,000 records per scheduled batch per minute, max outbound messages per hour); a **test mode** (dry run against a chosen record showing the path taken and the would-be changes); error handling paths per node (fault connector); an admin kill switch per flow and globally.
- **Templates gallery:** 15 prebuilt flows (e.g. "New web lead → assign → WhatsApp welcome template → task for owner in 5 min", "Stage = Proposal for 14 days → notify manager", "Closed Won → create order + onboarding tasks", "Contract ends in 60 days → renewal opportunity").

### 7.16 Approval processes (M16, P09)
- **Definition:** object, entry criteria (formula), initial submitter permissions, **record lock** during approval (admins and approvers can edit), ordered **steps** each with criteria (skip if not met), approver(s): the submitter's manager (hierarchy, N levels up), a specific user, a queue, members of an org unit or group, or a related user field (e.g. Account owner); **unanimous or first response**; **parallel** steps allowed. Actions on submit, approve, reject, recall and final approve/reject: field updates, email, notification, flow trigger.
- **Approver experience:** Approvals inbox (T7): list + detail with a record snapshot, a diff of what triggered approval (e.g. discount 22% vs threshold 15%), comment, Approve / Reject / Reassign. Email approve/reject by reply (signed token, `APPROVE`/`REJECT` first-line keywords) and mobile-friendly actions. **Delegated approver** during OOO.
- **Escalation:** auto-remind at X hours; auto-escalate to the next level at Y hours.
- History on the record (the Approval History related list).

### 7.17 Data management (M21)
Mass update (any editable field, with preview count); **mass transfer** of ownership (with options: open opportunities only, keep teams, transfer tasks); mass delete (Modify All required, recycle bin); **scheduled full data export** (weekly or monthly, CSV per object, zipped, to S3 with a download link, admin only); **field history** (up to 60 tracked fields per object, 24-month retention default, configurable up to 10 years on higher plans); **data quality** dashboard (completeness % per key field, duplicates, stale records); **GDPR/PDPL tooling** (P12): DSAR search by email/phone across all objects → export package (JSON + attachments) → **erase or anonymise** (replace PII with tokens, keep aggregate metrics), consent ledger, retention policies (auto-anonymise leads untouched for N months).

### 7.18 Notifications (M24)
In-app bell (real-time), email, and **web push** (PWA, P12). Types: assignment, mention, task due, SLA warning/breach, approval request/decision, AI insight (deal risk), import finished, report ready, flow error (admins), quota milestone. Per-type channel preferences, **daily digest**, quiet hours. Every notification deep-links to the record and action.

### 7.19 Global search and command palette (M25)
- **⌘K / Ctrl+K palette:** search records (all searchable objects, grouped, top 5 per object, typo-tolerant), **commands** ("Create lead", "Log a call", "Go to Forecast", "Switch to dark mode", "Open dialer"), recent items, and **ask AI** (P07: "> " prefix switches to the assistant).
- **Search results page:** facets by object, owner, date; FLS- and sharing-filtered.
- **Engine:** Postgres `tsvector` (weighted A: name/email/phone, B: company, C: other text) + `pg_trgm` for fuzzy matching and phone suffix matching. Target p95 < 200 ms at 5M leads. The `SearchProvider` interface allows an **OpenSearch** adapter (P12), used when a tenant exceeds 2M records per object or when latency budgets are breached.

### 7.20 Home pages ("Today")
Role-aware, configurable by admins (component slots):
- **Rep:** greeting + date, **My queue** (next best records, from NBA §8.3), tasks due (overdue, today), callbacks due, SLA-at-risk leads, meetings today (with AI prep brief), pipeline snapshot (my open by stage), **quota ring**, streak and badges, recent items.
- **Manager:** team attainment vs quota, **deals at risk** (P07), approvals waiting, team activity heatmap (calls per hour × day), SLA breaches, forecast submission status, leaderboard.
- **Admin:** setup health (failed flows, sync errors, import errors, users without MFA, storage usage, plan limits).

### 7.20a Onboarding (self-serve)
Sign up (email or Google/Microsoft) → verify email → **Create organisation**: name, subdomain slug, **data region** (with a plain-language residency explainer), corporate currency, timezone, fiscal year start, team size band (used only for defaults) → **setup wizard** (skippable, with resumable progress checklist on Home): (1) invite teammates (bulk paste emails, assign profiles), (2) confirm the default pipeline stages or pick a template (B2B sales, Telesales, Agency, Real estate: stage sets only, no vertical objects), (3) import leads (CSV) or **load sample data**, (4) connect email, (5) set up a web form, (6) choose a plan (14-day trial of the top plan; no card needed to start). Time-to-first-value target: **first lead worked within 10 minutes of signup**.

### 7.21 PWA and mobile layouts (M27)
Responsive breakpoints (§9.9). Mobile layouts: bottom tab bar (Home, Search, Create, Tasks, More), list → full-screen record, sticky action bar (Call, WhatsApp, Email, Log), and swipe actions on list rows (complete task, log call). **Installable PWA** (manifest, icons, splash). **Offline read** of the last 200 viewed records + today's tasks (IndexedDB via a service worker, encrypted with a session-derived key, cleared on logout). Offline task completion and notes queue for sync. Web push notifications. Native click-to-call via `tel:` with a post-call "Log this call?" prompt when the app regains focus.

---

## §8. AI LAYER (M14, P07; interfaces stubbed from P00)

### 8.1 Architecture
- `@sm/ai` package: `AIGateway` with `complete()`, `stream()`, `structured<T>(schema: ZodSchema<T>)`, `toolLoop()`, `embed()`, `transcribe()`. Providers implement `LLMProvider`, `EmbeddingProvider` and `SpeechProvider`.
- **Default providers:** LLM = **Anthropic Claude API** (model IDs from env, never hard-coded: `AI_MODEL_FAST=claude-haiku-4-5-20251001` for classification, extraction and routing; `AI_MODEL_SMART=claude-sonnet-5` for reasoning, drafting and agents; `AI_MODEL_DEEP=claude-opus-5-5` optional for heavy analysis); Embeddings = **Voyage AI** (`EMBEDDING_MODEL` env); Speech-to-text = **Deepgram** (adapter interface; AssemblyAI as the alternative).
- **Prompt registry:** prompts live in `packages/ai/prompts/*.md` with front-matter (id, version, model tier, output schema), are loaded into `ai_prompt_template`, and are versioned. Every AI call logs `prompt_id@version`.
- **Every structured call** validates output against a zod schema; on failure it retries once with the validation error, then fails gracefully with a UI fallback.
- **Metering:** `ai_usage_event` (tenant, user, feature, model, input/output tokens, cost estimate, latency). Plans include **AI credits per month** (§12). Soft warning at 80%, hard stop at 100% for non-critical features with an admin override, and a per-tenant daily cost ceiling as a safety cap.
- **Resilience:** timeouts (fast 8 s, smart 45 s), provider circuit breaker, queue non-interactive work in the `ai` queue, and cache deterministic results (e.g. an email classification keyed by message hash).

### 8.2 AI data governance
- Tenant-level **AI settings:** enable/disable per feature; **PII redaction** mode (off / mask emails & phones before sending / strict); data-retention statement (the provider does not train on API data); per-region provider endpoints where available.
- **Context builders** fetch data **as the requesting user** through the Query Engine: FLS and sharing always apply. For agents, the context runs as the agent's **run-as user** (an integration user with a dedicated profile).
- **Prompt-injection defence:** all third-party text (emails, WhatsApp, web form input, transcripts, notes) is wrapped as untrusted data in delimited blocks; system prompts instruct the model to treat it as data only; tools are allow-listed per feature; **no tool can send external messages without an approval gate** unless the admin has explicitly enabled auto-send for that agent action type; outputs are validated before any write.
- **Explainability:** every AI output stored in `ai_insight` holds its inputs summary, factors, prompt version and model, and is shown behind an "i" or "Why?" affordance.
- **Feedback:** 👍/👎 + a reason on every AI output → `ai_feedback`, reviewed in the admin AI dashboard.

### 8.3 Next-best-action (NBA) and "My queue"
For each rep, rank open leads and opportunities by an **NBA score** = f(lead/opp score, SLA urgency, callback due, days since last touch vs cadence target, stage age vs median, engagement recency, deal value, close-date proximity). The signal computation is deterministic (SQL + TS). The LLM adds a **one-line rationale** and a **suggested action** (Call, WhatsApp, Email with a draft, Schedule meeting, Update close date, Ask for a decision-maker intro), computed in batches every 15 minutes and on key events. The queue is shown on Home and in the dialer list as an ordering option.

### 8.4 Predictive lead scoring
- **Cold start** (< 300 converted + 300 unconverted closed leads): rules score (§7.4) + an **LLM fit assessment** against the tenant's **ICP definition** (admin-written text + example won accounts), producing a 0–100 fit score, 3 reasons and a confidence level.
- **Trained model** (≥ threshold): `apps/ml` (Python, FastAPI, LightGBM) trains **per tenant** weekly on the lead feature vector (source, industry, size, country, title seniority, engagement counts, response times, form fields, …) with conversion as the label, reports AUC in the admin UI, and uses **SHAP** values for top factors. The model is only activated if AUC ≥ 0.70 on the hold-out set; otherwise it stays in cold-start mode. Scores are served via the worker → `record_score`.

### 8.5 Conversation intelligence
- **Call summaries:** recording (from the provider) → transcription (diarised) → Claude → `{summary, key_points[], objections[], next_steps[], sentiment, talk_ratio, questions_asked, suggested_field_updates[]}` → logged on the call activity. **Suggested field updates** (e.g. budget, timeline, stage) appear as accept/reject chips; nothing is written without a click. Supports multilingual audio (Arabic, Hindi and Urdu transcripts summarised in English), flagged as best-effort.
- **Email and WhatsApp thread summaries** on demand and in the record's AI tab.
- **Meeting prep brief:** 30 minutes before a meeting: account snapshot, last interactions, open opportunities, risks, and 3 suggested questions.

### 8.6 Drafting
Email and WhatsApp drafting in the composer: "Draft reply", "Follow up after call", "Re-engage cold lead", "Send proposal"; tone (formal, friendly, concise), length, and language (English default; the draft can be in other languages even though the UI is English-only). Uses record context (FLS-filtered) + the thread + the tenant's **brand voice** setting + templates. For WhatsApp outside the 24 h window, the draft must pick an approved template and fill its variables.

### 8.7 Natural-language reports and answers
- User question → Claude with **tools** `list_objects`, `describe_object(fields visible to the user)`, `build_report(spec)` → returns a **ReportDefinition JSON** (validated against metadata and permissions) → executed by the normal report engine → shown as a report with an **"Edit report"** option. **The LLM never writes SQL.**
- Answers that need numbers always come from executed queries; the assistant must cite which report or records it used.

### 8.8 Deal-risk and pipeline intelligence
Nightly + on-change evaluation of every open opportunity: **risk signals** (days in stage > P75 for that pipeline stage, no activity in N days, close date pushed ≥ 2 times, amount decreased, no contact role with decision-maker title, single-threaded (1 contact), negative sentiment in the last call, competitor mentioned, quote expired). Deterministic signal scoring → risk level (Low, Medium, High) → LLM one-paragraph explanation + 2 recommended actions → a **risk badge** on Kanban cards and records, the "Deals at risk" manager widget, and an optional notification.

### 8.9 AI assistant (⌘J side panel)
A chat panel available everywhere, aware of the current page (record, list, report). **Tools** (all executed as the user): `search_records`, `get_record`, `query_records` (SMQ), `run_report`, `create_task`, `log_activity`, `update_fields` (**requires an inline confirm card** showing the diff), `draft_email`, `draft_whatsapp`, `summarise_record`, `explain_score`, `explain_assignment`. Streaming responses with citations (record chips). Conversation history is kept per user for 30 days.

### 8.10 Agents (with human approval gates)
- **Agent definitions** (admin-configurable, off by default): run-as integration user, trigger (event, schedule or flow node), scope filter, allowed tools, **action policy per action type** (`AUTO` | `REQUIRE_APPROVAL` | `FORBIDDEN`), daily run and cost budget, and approvers (record owner, manager, queue).
- **Built-in agents (v1):**
  1. **Inbound Qualifier:** new inbound lead → enrich from provided data (no web scraping in v1), classify intent, set fit fields, route or propose disqualification with a reason.
  2. **Follow-up Agent:** leads or opportunities untouched past the cadence → drafts a personalised email or WhatsApp (template) + task → **approval required** to send.
  3. **Data Hygiene Agent:** weekly: detect duplicates, stale close dates, missing required-for-stage fields → proposes fixes in bulk.
  4. **Meeting Prep Agent:** creates prep briefs (no approval needed: read-only output).
  5. **Pipeline Review Agent:** weekly per manager: a summary of changes, risks and slippage, with proposed forecast-category changes (approval by the rep or manager).
- **Approval inbox** (T7): proposed actions grouped by agent and record, with a diff, rationale, confidence and sources → Approve / Edit & approve / Reject (with a reason fed back to the agent's feedback log). Bulk approve for low-risk types. External communications default to `REQUIRE_APPROVAL` and **cannot** be set to `AUTO` unless a tenant admin with `manage_automations` explicitly enables it and accepts a warning.
- **Full audit:** every agent run → `ai_agent_run` (inputs, tool calls, outputs, cost); every executed action → the normal audit log with `actor = agent:{id} on behalf of approver {user}`.
- **Kill switch:** per agent and a tenant-wide AI switch.

---

## §9. DESIGN SYSTEM: "SalesMaker Design Language" (SDL). MANDATORY.

> The design is locked. Claude Code implements it exactly in `packages/ui` (`@sm/ui`), with Storybook documenting every token and component. Deviations need an ADR and owner approval. Reference feel: **Salesforce Lightning's information density with Linear/Attio polish and speed.** Dense, calm, fast, keyboard-first, and never decorative for its own sake.

### 9.1 Design principles
1. **Density with air.** Show a lot, but keep a strict 4-px rhythm, clear alignment and generous group spacing. Tables and records are the product, so they are designed first.
2. **Speed is a feature.** Optimistic updates, skeletons (never spinners for content), instant local filtering, prefetch on hover, and 100–160 ms motion.
3. **Keyboard-first, mouse-friendly.** Every primary action has a shortcut. ⌘K reaches everything.
4. **One accent, used sparingly.** The Jade brand colour marks primary actions, selection and focus. Status colours carry meaning only. The **Iris** accent is reserved **exclusively for AI** surfaces.
5. **Calm by default, loud on exceptions.** Neutral surfaces; colour is spent on SLA breaches, risks and errors.
6. **Progressive disclosure.** Reps see the working set; admins open Setup for depth.
7. **Every state is designed.** Empty, loading, partial, error, no-permission, offline, and read-only (locked by approval).

### 9.2 Colour tokens
Primitive scales (use via semantic tokens only):

**Graphite (neutral)**
| 0 | 25 | 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 850 | 900 | 950 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| #FFFFFF | #FBFCFC | #F6F7F8 | #EEF0F2 | #E1E4E8 | #CBD0D6 | #9AA2AD | #6B7480 | #4C5561 | #363E49 | #242A33 | #1B2028 | #14181E | #0C0F13 |

**Jade (brand / primary)**
| 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 950 |
|---|---|---|---|---|---|---|---|---|---|---|
| #EEF8F6 | #D3EFEA | #A7DED5 | #72C7BA | #3FAA9B | #1E8E80 | #117567 | #0E5F54 | #0D4C44 | #0B3E38 | #062623 |

**Iris (AI only)**: 50 #F3F1FC · 100 #E6E2F9 · 200 #CDC5F3 · 300 #A99CE8 · 400 #8A79DC · 500 #6D5BD0 · 600 #5A48BD · 700 #4A3A9E · 800 #3B2F7D · 900 #2C2459
**Success**: 50 #ECF7F1 · 100 #D1EDDD · 500 #1F9A5E · 600 #16794A · 700 #115E3A
**Warning**: 50 #FDF5E7 · 100 #FAE6C2 · 500 #D98A12 · 600 #A15C07 · 700 #7E4806
**Danger**: 50 #FDEDEC · 100 #F9D3D1 · 500 #E0463E · 600 #C0322B · 700 #9A2721
**Info**: 50 #EDF4FD · 100 #D3E4FA · 500 #3B82E0 · 600 #1F63C6 · 700 #184E9C

**Semantic tokens** (CSS variables in `packages/ui/src/tokens/*.css`; Tailwind v4 `@theme` maps them):
| Token | Light | Dark |
|---|---|---|
| `--bg-canvas` (app background) | graphite-50 #F6F7F8 | graphite-950 #0C0F13 |
| `--bg-surface` (cards, tables, panels) | #FFFFFF | graphite-900 #14181E |
| `--bg-surface-raised` (popover, menu, modal) | #FFFFFF | graphite-850 #1B2028 |
| `--bg-subtle` (table header, section header) | graphite-25 #FBFCFC | #171B22 |
| `--bg-muted` (input fill disabled, chips) | graphite-100 #EEF0F2 | graphite-800 #242A33 |
| `--bg-hover` | graphite-100 #EEF0F2 | #1F252E |
| `--bg-selected` | jade-50 #EEF8F6 | #0F2E2A |
| `--bg-sidebar` | graphite-900 #14181E | #0A0D10 |
| `--border-subtle` (row dividers) | graphite-100 #EEF0F2 | #20262F |
| `--border-default` (inputs, cards) | graphite-200 #E1E4E8 | #2A313B |
| `--border-strong` | graphite-300 #CBD0D6 | #3A424E |
| `--border-focus` | jade-500 #1E8E80 | jade-400 #3FAA9B |
| `--text-primary` | graphite-900 #14181E | #E8EBEF |
| `--text-secondary` | graphite-600 #4C5561 | #A9B1BC |
| `--text-tertiary` (meta, placeholders) | graphite-500 #6B7480 | #7D8693 |
| `--text-disabled` | graphite-400 #9AA2AD | #525A66 |
| `--text-inverse` | #FFFFFF | graphite-950 |
| `--text-link` | jade-700 #0E5F54 | jade-300 #72C7BA |
| `--text-on-sidebar` / `--text-on-sidebar-muted` | #E8EBEF / #9AA2AD | same |
| `--action-primary-bg` / `-hover` / `-active` | jade-600 #117567 / jade-700 / jade-800 | jade-400 #3FAA9B / jade-300 / jade-200 |
| `--action-primary-fg` | #FFFFFF | jade-950 #062623 |
| `--action-secondary-bg` / `-border` / `-fg` | #FFFFFF / graphite-200 / graphite-800 | graphite-850 / #2A313B / #E8EBEF |
| `--action-danger-bg` / `-fg` | danger-600 / #FFFFFF | danger-500 / #FFFFFF |
| `--status-{success,warning,danger,info}-fg` | *-700 | *-400-equivalent: #5CC48F, #F0B458, #F2847E, #7FB0F0 |
| `--status-{…}-bg` | *-50 | 12% alpha of *-500 over surface |
| `--ai-accent` / `--ai-bg` / `--ai-border` | iris-600 / iris-50 / iris-200 | iris-300 / rgba(109,91,208,.14) / iris-700 |
| `--overlay` (modal scrim) | rgba(12,15,19,.48) | rgba(0,0,0,.64) |

**Categorical palette** (pipeline stages, charts, tags; 8 slots, in order; each has `-fg`, `-bg` and `-solid` variants):
`cat-1 Jade #1E8E80` · `cat-2 Cobalt #3B6FD4` · `cat-3 Iris #6D5BD0` (charts only, never an AI implication on stage chips; stage chips skip slot 3) · `cat-4 Rose #C2527A` · `cat-5 Amber #D07A1F` · `cat-6 Olive #5E8F2E` · `cat-7 Cyan #2E9BB8` · `cat-8 Clay #8A6A4F`.
Sequential (heatmaps, gauges): jade-50 → jade-900. Diverging (variance vs target): danger-500 ← graphite-200 → success-500.
**Won** = success, **Lost** = graphite-400 (not red: a loss is information, not an error). **Overdue/breach** = danger. **At-risk** = warning.
**Contrast rule:** all text/background pairs ≥ 4.5:1 (≥ 3:1 for ≥ 18 px semibold and for UI component boundaries). A token-contrast unit test (`tokens.contrast.test.ts`) fails CI on violations.

### 9.3 Typography
- **UI font:** **Inter Variable** (self-hosted via `next/font`), features `"cv11","ss01","tnum"` in tables and number cells (`font-variant-numeric: tabular-nums`). **Mono:** **JetBrains Mono** for IDs, API keys, formulas and code. **Future Arabic:** **IBM Plex Sans Arabic** is declared in the font stack now (not loaded until RTL is enabled).
- **Type scale** (size/line-height, weight). Default density:
| Token | Size/LH | Weight | Use |
|---|---|---|---|
| `display` | 28/34 | 650 | Dashboard hero numbers, empty-state headlines |
| `title-1` | 22/28 | 600 | Page titles |
| `title-2` | 18/24 | 600 | Record name in the Highlights Panel, modal titles |
| `title-3` | 15/22 | 600 | Section headers, card titles |
| `body` | 14/20 | 400 | Default text, form fields |
| `body-strong` | 14/20 | 550 | Field values that need emphasis, links in tables |
| `body-sm` | 13/18 | 400 | Table cells (default density), secondary text |
| `label` | 12/16 | 500 | Field labels, column headers (sentence case, graphite-500, **no uppercase**) |
| `caption` | 12/16 | 400 | Metadata, timestamps, helper text |
| `micro` | 11/14 | 500 | Badges, counters, keyboard hints |
- **Compact density** shifts `body` → 13/18 and `body-sm` → 12/16 (and table cells to 12/16). **Comfortable** shifts `body-sm` in tables → 14/20.
- Numbers: amounts right-aligned in tables, with currency code or symbol per user locale via `Intl.NumberFormat`. Large numbers are abbreviated in KPI tiles only (`1.2M`), with the full value in a tooltip.

### 9.4 Spacing, sizing, radius, elevation, motion
- **Spacing scale (px):** 0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80. Tokens `space-0 … space-13`. The component inner padding and gaps must come from this scale.
- **Control heights:** `sm` 28 · `md` 32 (default) · `lg` 40. Touch targets on mobile ≥ 44.
- **Radius:** `r-xs` 4 (badges, checkboxes, chips) · `r-sm` 6 (buttons, inputs, menu items) · `r-md` 8 (cards, popovers, Kanban cards) · `r-lg` 12 (modals, sheets, command palette) · `r-full` (avatars, pills).
- **Elevation (light):** `e-0` none + 1 px `--border-default` · `e-1` `0 1px 2px rgba(20,24,30,.06)` (cards) · `e-2` `0 4px 12px rgba(20,24,30,.08), 0 1px 3px rgba(20,24,30,.06)` (popovers, dropdowns, dragging card) · `e-3` `0 16px 40px rgba(20,24,30,.16)` (modals, palette). **Dark:** shadows are reduced to 40% opacity, and elevation is expressed by lighter surfaces (`surface` → `surface-raised`) + a 1 px border.
- **Motion:** `dur-fast` 100 ms (hover, press), `dur-base` 160 ms (popover, tab, row expand), `dur-slow` 240 ms (sheet, modal, page-level). Easing `ease-standard cubic-bezier(.2,0,0,1)`, `ease-exit cubic-bezier(.4,0,1,1)`. No bounce and no spring overshoot except the Won celebration. Honour `prefers-reduced-motion` (fade only, 0–80 ms).
- **Z-index:** base 0 · sticky header 10 · sidebar 20 · dropdown/popover 40 · softphone dock 50 · sheet 60 · modal 70 · command palette 80 · toast 90 · tooltip 100.
- **Iconography:** **Lucide**, 16 px default (14 px compact, 20 px in the empty state, 24 px on mobile nav), stroke 1.75, `currentColor`. Icons that imply direction (arrows, chevrons, send, undo) carry `data-mirror` for RTL. Object icons: each standard object has a fixed icon and categorical colour chip (Lead = Cobalt, Account = Jade, Contact = Cyan, Opportunity = Amber, Campaign = Rose, Quote = Olive, Order = Clay, Task = graphite).
- **Focus:** a 2 px `--border-focus` ring with 2 px offset (`outline` + `outline-offset`), on every interactive element. Never removed; `:focus-visible` only.

### 9.5 Density modes
User preference (Settings → Display), stored on the user, applied via `data-density` on `<html>`:
| | Comfortable | Default | Compact |
|---|---|---|---|
| Table row height | 44 | 36 | 28 |
| Control height default | 40 | 32 | 28 |
| Page padding | 32 | 24 | 16 |
| Card padding | 20 | 16 | 12 |
| Field grid vertical gap | 16 | 12 | 8 |
| Kanban card padding | 12 | 10 | 8 |
Defaults: **Default** density on desktop, **Comfortable** on touch devices. Telesales profiles default to **Compact**.

### 9.6 Themes
`data-theme="light|dark|system"` on `<html>`, persisted per user, `system` by default. No flash of the wrong theme (an inline script sets the attribute before paint). **All charts, the Kanban, the softphone, PDFs (always light) and emails (light, with dark-mode-safe colours) must be verified in both themes** by Playwright visual snapshots.

### 9.7 App shell and layout
```
┌─────────┬──────────────────────────────────────────────────────────────────────┐
│         │ Top bar 48: [≡] Breadcrumbs ······ [⌘K Search……] [+ New ▾] [AI ✦] [🔔] [Avatar] │
│ Sidebar ├──────────────────────────────────────────────────────────────────────┤
│  232 /  │ Page header 56: Title · view switcher · filters ········ primary actions   │
│   56    ├──────────────────────────────────────────────────────────────────────┤
│ (dark)  │ Content (canvas bg, padding by density)                                │
│         │                                                                       │
│         │                                            ┌──────── softphone dock ─┐ │
└─────────┴────────────────────────────────────────────┴─────────────────────────┴─┘
```
- **Sidebar** (dark `--bg-sidebar` in both themes, for a stable frame): org logo + switcher, then **Home**, **Inbox** (unified WhatsApp/SMS/email, approvals, AI proposals, with a badge), **Leads**, **Accounts**, **Contacts**, **Opportunities**, **Pipeline** (Kanban), **Activities / Tasks**, **Dialer**, **Quotes & Orders**, **Forecast**, **Reports**, **Dashboards**, then a "Pinned" section (favourite list views and records), then custom objects (admin-orderable), and at the bottom **Setup** (if permitted), Help, and the collapse toggle. Collapsed mode 56 px shows icons + tooltips. Keyboard: `[` toggles it. Items can be hidden per profile (app/tab visibility).
- **Top bar:** breadcrumbs, **global search trigger** (opens ⌘K), **+ New** menu (objects the user can create), **AI assistant** button (Iris; ⌘J), notifications, and the avatar menu (profile, theme, density, shortcuts, sign out).
- **Record tabs:** opening records from lists adds **workspace tabs** below the top bar (max 12, overflow menu, middle-click to close, `⌘W` closes the current tab, and the tab set persists per user). This is the "tabbed record views" requirement and matters for telesales multitasking.
- **Softphone dock:** bottom-end (bottom-right in LTR), 360 px wide when expanded, 48 px pill when minimised, and persistent across navigation.
- **Toasts:** bottom-start (bottom-left in LTR), max 3 stacked, 5 s (errors persist until dismissed), always with an **Undo** action when the operation is reversible.

### 9.8 Page templates (every screen must use one)
| ID | Template | Structure |
|---|---|---|
| **T1** | **Object list** | Page header (object name, view picker, record count "12,408" or "100k+", search-in-view, filter chips, view toggles List/Kanban/Split, density, columns, primary **New**) → data grid full height with sticky header and sticky first column, virtualised rows, footer with selection count and mass actions bar sliding up when rows are selected |
| **T2** | **Record** | Highlights Panel (object icon chip, record name `title-2`, compact fields in a row, owner avatar, follow, primary actions (max 3 visible + overflow)) → **Path** (for records with stages) → body: main column (tabs: Overview · Activity · Related · History · AI) + right rail 360 px (composer + upcoming + AI insights card) → collapses to tabs under 1280 px |
| **T3** | **Board** | Page header with pipeline picker + filters + totals → horizontal scrolling columns, 280 px each (min 248, max 320), column header (stage name, count, sum, weighted), cards, "+ Add" at the column foot |
| **T4** | **Dashboard** | Header with filters + refresh time + edit toggle → 12-column grid, component cards (title, subtitle "as of", overflow menu: view report, export, full screen) |
| **T5** | **Setup / admin** | Setup sidebar (searchable tree: Company, Users & Access, Objects & Fields, Automation, Sales Settings, Channels, AI, Data, Integrations, Security, Billing) + content page with header, description, and a form or table; **all setup pages are deep-linkable** |
| **T6** | **Wizard** | Centered 720 px column, stepper on top, one decision per step, sticky footer with Back/Next, and a side preview panel for imports and forms |
| **T7** | **Inbox (split)** | List pane 360 px (filters, grouping) + detail pane (conversation or approval detail) + an optional context rail (record summary) |
| **T8** | **Builder canvas** | Full-bleed canvas (React Flow) with a toolbar at the top (name, version, status, Test, Activate), a node palette at start, a properties panel at end 400 px, and a bottom run-history drawer |
| **T9** | **Auth / marketing-light** | Split: brand panel (Jade gradient `jade-700 → jade-900` with product illustration) + form panel 440 px |
| **T10** | **Wallboard / TV** | Dark-only, 1920×1080-optimised grid, `display`-size numbers, auto-rotating panels every 20 s, no interactive chrome |

### 9.9 Responsive rules
Breakpoints: `sm` 640 · `md` 768 · `lg` 1024 · `xl` 1280 · `2xl` 1536 · `3xl` 1920.
- < `md`: mobile layout (bottom tab bar, no sidebar, full-screen sheets for create/edit, lists as cards not grids, Kanban as a single-column swipeable stage view).
- `md`–`lg`: sidebar collapsed by default; the record right rail becomes a tab.
- ≥ `xl`: full layout. ≥ `3xl`: the record main column caps at 1200 px, and the rail grows to 420 px.

### 9.10 Component specifications (build in `@sm/ui`, each with Storybook stories for every variant × state × theme × density)
| Component | Variants / key specs | States |
|---|---|---|
| **Button** | primary, secondary, ghost, danger, ai (Iris outline + sparkle icon), link; sizes sm/md/lg; icon-only (square, tooltip required); loading keeps width | default, hover, active, focus, disabled, loading |
| **Input / Textarea** | 1 px border `--border-default`, `r-sm`, prefix/suffix slots, clear button, char counter | default, hover, focus, invalid (danger border + message), disabled, read-only (no border, text only) |
| **Select / Combobox** | Radix-based, searchable when > 7 options, multi-select with chips, async search for lookups (debounce 150 ms, shows object icon + secondary field), "Create new…" option when allowed | + empty, loading |
| **Lookup field** | shows the record chip with hover card (compact layout) | |
| **Date / DateTime picker** | locale-aware, keyboard typing supported ("tomorrow 3pm" natural-language parsing), relative shortcuts | |
| **Currency / Number input** | right-aligned, locale grouping, currency selector if multi-currency enabled | |
| **Picklist badge / Status chip** | `r-xs`, `micro` text, colour from categorical or status tokens, dot variant | |
| **Avatar** | 16/20/24/32/40, initials fallback with a deterministic colour, presence dot (agent state) | |
| **Data grid** (the most important component) | TanStack Table + Virtual; sticky header/first column; column resize (drag), reorder (drag), pin, hide; sort (multi with shift); inline edit per cell type with the FLS-aware editor; checkbox selection with range (shift-click); row hover actions (end side); keyboard grid navigation (arrow keys, Enter edit, Esc cancel, Tab next cell); grouped rows (collapsible) with aggregates; loading skeleton rows; "load more" by keyset; column-type formatting (currency, date relative "3d ago" with an absolute tooltip, phone click-to-call, email click-to-compose, lookup chip, SLA chip, score chip); **empty, no-results, error, no-permission** states | 60 fps scroll at 10k rendered rows |
| **Kanban card** | `r-md`, `e-1`, 3–4 fields, avatar, next-activity date (red if overdue), days-in-stage, risk badge (Iris-outlined if AI-derived), drag handle (whole card), keyboard move (Space to pick, arrows to move, Space to drop, announced for screen readers) | idle, hover, dragging (`e-2`, 2° tilt disabled with reduced motion), drop target |
| **Path (stage bar)** | chevron segments, completed = jade-600 with check, current = jade-100 bg + jade-800 text, future = graphite-100; "Mark stage complete" button; guidance drawer | |
| **Highlights Panel** | see T2 | |
| **Timeline item** | icon chip by activity type, title line, meta line (user, time), body (collapsed at 3 lines), actions (reply, pin, edit, delete) | |
| **Activity composer** | tabbed (Call · Email · WhatsApp · Task · Meeting · Note); email and WhatsApp editors have an AI "Draft" button | |
| **Command palette** | 640 px wide, `r-lg`, `e-3`; sections (Records, Commands, Recent, Ask AI); fuzzy matching with match highlighting; `↑↓ Enter`; `Tab` to scope by object | |
| **Modal / Dialog** | sm 400, md 560, lg 800, xl 1040; header, scrollable body, sticky footer; focus trap; Esc closes (with a dirty-form confirm) | |
| **Sheet (side panel)** | end side, 480/640/800, for quick views and create forms | |
| **Popover / Hover card** | `e-2`, `r-md`, 300 ms hover delay for record hover cards | |
| **Tabs** | underline style (2 px jade-600 indicator), counts as `micro` badges | |
| **Toast** | success, error, info, with an action (Undo, View) | |
| **Banner** | inline info/warning/danger/AI across the top of a page or card (e.g. "This record is locked for approval") | |
| **Empty state** | 20 px icon in a 40 px muted circle, `title-3` headline, one sentence, one primary action, optional "Learn more"; teaching copy, never "No data" | |
| **Skeleton** | shimmer disabled with reduced motion; matches final layout geometry | |
| **KPI tile** | label, value (`display` or `title-1`), delta vs previous period (success/danger arrow + %), sparkline optional | |
| **Chart frame** | title, subtitle, legend (top, start), tooltip (surface-raised, `e-2`), "View report" link; axis text `caption` tertiary; gridlines `--border-subtle`; no 3D, no pie > 6 slices (use a bar) | |
| **Softphone** | states: idle (dial pad), ringing (inbound: caller match card, Accept/Decline), connecting, in-call (timer, mute, hold, transfer, keypad, notes, end), wrap-up (disposition list with keyboard numbers 1–9, notes, schedule callback, countdown ring), error (device or permission) | |
| **AI surfaces** | Iris left border 2 px or Iris sparkle icon `✦`; label "AI" + "Why?" link; always **Apply / Edit / Dismiss**; streaming text caret; never auto-applied without a visible confirm (except agents set to AUTO, which show "Applied by agent" with Undo) | |
| **Score chip** | 0–100 with grade letter; colour by band (A jade, B cobalt, C amber, D graphite); hover shows the factors | |
| **SLA chip** | countdown "12m left" (warning under 25%), "Breached 3h" (danger) | |
| **Form layout** | 1 or 2 column responsive grid; label above field (never floating labels); required marked with `*` in danger-600 plus `aria-required`; helper text below; errors replace helper text | |

### 9.11 Interaction and keyboard standards
Global: `⌘K` palette · `⌘J` AI assistant · `/` focus search in view · `C` create (context object) · `G then L/A/C/O/P/H/F/R/D` go to Leads/Accounts/Contacts/Opportunities/Pipeline/Home/Forecast/Reports/Dashboards · `?` shortcut sheet · `⌘\` toggle right rail · `[` toggle sidebar.
Lists: `J/K` move · `X` select · `Enter` open · `E` edit cell · `Shift+E` bulk edit selected.
Record: `E` edit · `L` log call · `M` email · `W` WhatsApp · `T` task · `N` note · `⌘S` save · `Esc` cancel.
Softphone: `⌘⇧D` dial selected phone · `1–9` in wrap-up picks a disposition · `⌘Enter` "Save & next".
**Undo:** every destructive or bulk action shows an Undo toast for 8 s where technically reversible, and irreversible actions use a typed confirmation.
**Autosave:** long-text fields and builder canvases autosave drafts every 5 s. Forms warn on navigation with unsaved changes.
**Optimistic UI:** field edits, stage moves, task completion and disposition saves update instantly, and roll back with an error toast on failure.

### 9.12 RTL readiness (v1 ships English only; these rules make Arabic a translation + QA exercise, not a refactor)
1. Tailwind logical utilities only (`ms-*`, `me-*`, `ps-*`, `pe-*`, `start-*`, `end-*`, `text-start`, `border-s`, `rounded-s-*`). An ESLint rule (`no-restricted-syntax` / tailwind plugin) bans `ml-`, `mr-`, `pl-`, `pr-`, `left-`, `right-`, `text-left`, `text-right`, `border-l`, `border-r`, `rounded-l`, `rounded-r` in `apps/web` and `packages/ui`.
2. `dir` is set on `<html>` from the locale; all layouts are tested with `dir="rtl"` pseudo-locale **in Storybook and one Playwright smoke suite** from P00 (with English strings, to prove mirroring).
3. All strings go through `next-intl` with ICU MessageFormat (plurals, select, numbers, dates). Keys are namespaced (`leads.list.empty.title`). No string concatenation. A pseudo-locale (`en-XA`: accented, 30% longer) catches truncation.
4. Icons with direction carry `data-mirror` and flip via CSS in RTL. Charts: axis direction stays LTR for time series (the Arabic convention in business dashboards). This is documented in the ADR.
5. Numbers and dates use `Intl` with the user locale. Western Arabic numerals by default, with a locale option for Eastern Arabic later.
6. Fonts: the Arabic font is declared in the stack. Line-height tokens allow +10% for Arabic via a `[lang="ar"]` override.

### 9.13 Accessibility (WCAG 2.2 AA; release-blocking)
Keyboard operability for all features, including Kanban drag (keyboard alternative) and the flow builder (node list alternative view). Visible focus. Screen-reader labels for icon buttons. `aria-live` for toasts, softphone state and SLA countdowns (polite, throttled). Grid semantics (`role="grid"`) with row and column indices for virtualised tables. Colour is never the only carrier of meaning (status chips have text or icons). Minimum target size 24×24 (44×44 on touch). Respect reduced motion. **axe-core runs in Playwright on every T1–T10 page in CI; any serious or critical violation fails the build.**

### 9.14 Content and voice
Sentence case everywhere (titles, buttons, labels). Buttons are verbs ("Convert lead", "Log call", not "OK"). Errors say what happened + how to fix it ("Close date can't be in the past for open deals. Pick today or later."). Numbers include units. Use "you" for the user and never blame. Empty states teach the next action. AI copy is modest ("Suggested", "Draft") and never claims certainty. Dates are relative within 7 days ("Tomorrow 3:00 PM"), absolute beyond that ("12 Oct 2026").

### 9.15 Screen inventory (each screen → template; Claude Code builds a clickable route for every item by the phase shown)
| Area | Screens (template) | Phase |
|---|---|---|
| Auth | Sign in, Sign up, Verify email, Forgot/Reset password, MFA challenge, SSO redirect, Accept invite (T9) | P00–P01 |
| Onboarding | Create org, Setup wizard steps 1–6 (T6), Getting-started checklist (Home card) | P05 |
| Home | Rep Today, Manager Today, Admin Today (T4 variant) | P04, P07, P10 |
| Leads | List (T1), Record (T2), Convert dialog (modal), Import wizard (T6), Queue pick-up (T1), Duplicate review (T7), Merge (modal) | P02–P03 |
| Accounts / Contacts | List (T1), Record (T2), Account hierarchy view (tree), Merge | P02 |
| Opportunities | List (T1), Record (T2), Pipeline Kanban (T3), Close Won/Lost dialogs, Products editor (grid in modal) | P02, P04, P09 |
| Activities | My Tasks (T1), Calendar (week/day), Activity log | P04 |
| Inbox | Unified conversations (T7), Approvals (T7), AI proposals (T7) | P06, P07, P09 |
| Dialer | Dialer lists (T1), Dialer session (T2 variant with the softphone focused), Wallboard (T10), Agent state history | P06 |
| Quotes & Orders | Quote editor (T2 + line grid), Quote PDF preview, Orders (T1/T2), Contracts (T1/T2) | P09 |
| Forecast | Forecast grid (T1 variant), Adjustment modal, Trend view | P10 |
| Performance | Quotas setup, Leaderboards, Badges, Challenges | P10 |
| Reports | Reports home (folders, T1), Report builder (T8 variant: fields panel + preview), Report run (T1 variant) | P05, P11 |
| Dashboards | Dashboards home (T1), Dashboard view/edit (T4) | P05, P11 |
| Automation | Flows list (T1), Flow builder (T8), Run history (T1 + detail sheet), Templates gallery | P08 |
| AI | Assistant panel (sheet), Agents list (T5), Agent config (T5), AI usage dashboard (T4), AI settings (T5) | P07 |
| Setup | Company info, Regions & residency (read-only), Currencies & rates, Fiscal year, Business hours, Users, Org hierarchy (tree editor), Profiles, Permission sets & groups, Public groups, Queues, OWD & sharing rules, Territory models (tree + rules + preview), Object manager (objects, fields, layouts, record types, validation rules, compact layouts, path), Picklist value sets, Matching & duplicate rules, Assignment rules, SLA policies, Scoring models, Pipelines & stages, Web forms, Email-to-lead, Channels (email, WhatsApp, SMS, telephony), Dispositions & calling windows, DNC lists, Products & price books, Quote templates, Approval processes, Accounting integrations, API keys, Connected apps, Webhooks, Data import history, Data export, Recycle bin, Field history settings, GDPR/DSAR, Retention policies, Audit log, Login history, Setup audit trail, Jobs & dead letters, Security (MFA policy, session, IP ranges, SSO, SCIM), Billing & plan (T5) | P01–P12 |
| Personal settings | Profile, Display (theme, density, language/locale, timezone), Notifications, Connected accounts (email/calendar), Security (password, MFA, sessions, passkeys), Shortcuts | P01, P04, P06 |
| System | 404, 403 (no access, with "request access"), 500, maintenance, offline (PWA), plan-limit reached | P00, P05, P12 |

---

## §10. API AND INTEGRATION STANDARDS

### 10.1 Public REST API (`https://{region}.api.salesmaker.app/v1`)
- **Resource model:** generic metadata-driven endpoints that work for standard and custom objects, plus action endpoints.
  - `GET /v1/objects` · `GET /v1/objects/{object}/describe` (fields visible to the caller)
  - `GET /v1/records/{object}?fields=&filter=&sort=&limit=&cursor=` · `POST /v1/records/{object}` · `GET|PATCH|DELETE /v1/records/{object}/{id}` · `PUT /v1/records/{object}/external/{externalId}` (upsert)
  - `POST /v1/query` (SMQ JSON body, §3.8) · `GET /v1/search?q=&objects=`
  - Actions: `POST /v1/leads/{id}/convert`, `POST /v1/records/{object}/merge`, `POST /v1/opportunities/{id}/stage`, `POST /v1/records/{object}/{id}/share`, `POST /v1/assignment/run`, `POST /v1/approvals/{id}/submit|approve|reject`, `POST /v1/quotes/{id}/pdf`, `POST /v1/orders/{id}/activate`, …
  - Activities: `POST /v1/activities` (call/email/message/task/meeting/note) with `links[]`.
  - Metadata: `GET/POST /v1/metadata/{type}` + `GET/POST /v1/metadata/package`.
  - Reports: `POST /v1/reports/{id}/run`, `GET /v1/report-runs/{id}`.
- **Conventions:** JSON, camelCase; IDs are UUIDv7 strings; timestamps ISO-8601 UTC; money `{ "amount": "1250.00", "currency": "USD" }` (string decimals); **cursor pagination** (`next_cursor`), max `limit` 200; filter syntax `filter[status][in]=OPEN,WORKING&filter[amount][gte]=1000` or SMQ body; sparse fieldsets; `If-Match: <version>` for optimistic concurrency; **`Idempotency-Key`** on POST (24 h retention); errors **RFC 9457 problem+json** with `type`, `title`, `status`, `detail`, `errors[{field, code, message}]`, `traceId`.
- **Rate limits** per plan (token bucket, per tenant + per API key), with the headers `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and a daily API-call quota per plan.
- **Versioning:** URL major (`/v1`); additive changes only within v1; deprecations announced via a `Deprecation` + `Sunset` header ≥ 6 months ahead.
- **OpenAPI 3.1** generated from `@sm/contracts` on every build and published at `/v1/openapi.json`, with a docs site (Scalar or Redoc) at `developers.salesmaker.app`. CI fails if generated OpenAPI changes without a committed snapshot update (contract drift check).
- **SDK:** `@salesmaker/sdk` (TypeScript), generated from OpenAPI + hand-written helpers (pagination iterator, webhooks signature verification), published in P12.

### 10.2 Internal API (web ↔ api)
The same REST surface, plus internal-only endpoints under `/internal/*` (UI-optimised aggregates such as the board columns, the home widgets and the palette search), which are never exposed to API keys. The web app calls the API through thin Next.js route handlers only where cookies or SSR need them. Otherwise it calls directly with CORS locked to tenant origins.

### 10.3 Webhooks (outbound)
Subscriptions per tenant: event types (`lead.created`, `lead.converted`, `opportunity.stage_changed`, `opportunity.won`, `quote.accepted`, `order.activated`, `activity.call_completed`, `record.updated` with an object filter, …), a target URL (HTTPS only; SSRF-guarded), a secret, and an optional field filter. Payload: `{id, type, createdAt, tenantId, data:{object, id, fields…, changedFields[]}}` (fields filtered by the subscription owner's FLS). Signature header `SM-Signature: t=<ts>,v1=<HMAC-SHA256(secret, t + "." + body)>`. Delivery: at-least-once, retries with exponential backoff for up to 24 h (≈ 15 attempts), then auto-disable after 3 consecutive days of failures, with notification. Delivery log with request/response (truncated) and **replay**.

### 10.4 Bulk API
`POST /v1/bulk/jobs` (object, operation insert|update|upsert|delete, externalIdField) → upload CSV parts (pre-signed S3, up to 1M rows / 1 GB) → `close` → async processing through RecordService in batches → results file. Status polling or a webhook on completion.

### 10.5 Integration adapters (interfaces in `packages/integrations/*`)
`TelephonyProvider` (Twilio default), `SmsProvider` (Twilio, Unifonic slot), `WhatsAppProvider` (Meta Cloud API), `MailboxProvider` (Gmail, Microsoft Graph), `CalendarProvider` (Google, Microsoft), `LeadAdsProvider` (Meta, LinkedIn), `AccountingProvider` (Xero, QuickBooks), `ESignatureProvider` (stub), `SpeechProvider` (Deepgram), `LLMProvider` (Anthropic), `EmbeddingProvider` (Voyage), `SearchProvider` (Postgres, OpenSearch), `StorageProvider` (S3/MinIO), `EmailSender` (SES). Each adapter has a **fake implementation** for local dev and tests (record/replay fixtures), and **no real third-party calls happen in CI**.

### 10.6 Integration credentials
Per-tenant `integration_connection` (provider, status, scopes, encrypted tokens, expiry, last sync, error). Token refresh by worker. A health panel in Setup → Integrations shows each connection's status and last error in plain language.

---

## §11. NON-FUNCTIONAL REQUIREMENTS

### 11.1 Performance budgets (measured at the 800-rep demo tenant scale with 5M leads loaded; CI k6 + Lighthouse CI enforce them)
| Operation | Budget (p95 unless stated) |
|---|---|
| API record read (GET by id, with FLS) | ≤ 120 ms |
| API record write (create/update through RecordService, excluding async) | ≤ 250 ms |
| List view first page (50 rows, sharing on, 5M-row object, indexed filter) | ≤ 400 ms API · ≤ 800 ms to rendered rows |
| Kanban board initial (6 stages × 50 cards + aggregates) | ≤ 600 ms API |
| Global search (⌘K) | ≤ 200 ms API |
| Report run (summary, ≤ 200k matching rows, replica) | ≤ 3 s; async beyond that |
| Dashboard (10 components, cached) | ≤ 1.5 s to fully rendered |
| Softphone "Save & next" (disposition save + next record loaded) | ≤ 700 ms |
| Web vitals (desktop, logged-in app pages) | LCP ≤ 2.0 s, INP ≤ 200 ms, CLS ≤ 0.05 |
| JS per route (initial, gzip) | ≤ 200 KB app routes; ≤ 120 KB auth pages |
| Import throughput | ≥ 2,000 rows/s per tenant job (dedupe on), fair-shared |
| Sharing recalculation (criteria rule change, 1M records) | ≤ 10 min with progress |

### 11.2 Scale targets
Per tenant: 1,000 active users, 5M leads, 2M accounts, 3M contacts, 1M opportunities, 50M activities, 200M field-history rows. Platform (per cell at launch): 2,000 tenants, 20k concurrent users, 1,500 API rps sustained, 5,000 burst. **Load test (P12):** k6 scenario "Monday 9 AM telesales floor": 1,000 agents in one tenant doing the dial → disposition → next loop every 45 s + 50 managers on dashboards + a 500k-row import running, with the budgets above holding.

### 11.3 Availability and resilience
SLO 99.9% monthly for the app and API per cell. RDS Multi-AZ, PITR 35 days, **RPO ≤ 15 min, RTO ≤ 4 h** (cross-region encrypted snapshot copy daily, within the same jurisdiction where residency requires it). Zero-downtime deploys (rolling ECS, expand/contract migrations). Graceful degradation: if AI, search engine or telephony providers are down, the core CRM keeps working and the relevant UI shows a status banner. A status page at `status.salesmaker.app`.

### 11.4 Observability
OTel traces end to end (web → api → db → worker) with tenant and user attributes; RED metrics per route; queue depth and age per queue and tenant; DB slow-query log with `pg_stat_statements`; per-tenant usage dashboards (for noisy-neighbour detection); Sentry release tracking with source maps; alerting (p95 budget breach 10 min, error rate > 1%, queue age > 5 min, replica lag > 30 s, RLS audit failure = page). Logs never contain PII field values (redaction middleware for email/phone patterns).

### 11.5 Security controls (SOC 2-ready)
Branch protection + required reviews; signed commits encouraged; **CodeQL**, **Dependabot**, `pnpm audit`, **Trivy** container scan, **gitleaks** secret scan in CI; SBOM (CycloneDX) per release; least-privilege IAM via Terraform; secrets in AWS Secrets Manager (never in env files committed); an admin-action audit trail; quarterly access-review report export; vulnerability SLAs (critical 72 h, high 14 days); a pre-launch external **penetration test** (P12); a security.txt and responsible disclosure page.

### 11.6 Privacy and compliance (GDPR, Qatar PDPPL, UAE PDPL, KSA PDPL)
Data residency via cells; a DPA and sub-processor list page; lawful-basis and consent records; **DSAR tooling** (§7.17); retention policies; breach-notification runbook (`docs/runbooks/breach.md`: 72-hour GDPR clock, local regulator contacts listed as TODO for the owner); Records of Processing template; privacy by default (tracking pixels off, AI PII redaction option, minimal data in logs); cross-border transfer notes per region in the residency ADR.

### 11.7 Browser and device support
Latest 2 versions of Chrome, Edge, Safari and Firefox; iOS Safari 17+; Android Chrome latest. Minimum desktop viewport 1280×720 for the full layout; mobile ≥ 360 px wide.

---

## §12. BILLING, PLANS, ENTITLEMENTS

### 12.1 Model: flat price per organisation (locked decision #4)
Organisations pay one flat subscription fee per month or year. Plans differ by **features and limits, not by seat count**. Prices are set by the owner in Stripe; **the code never hard-codes prices**, it reads plans and entitlements from `cp_plan` (synced from Stripe Products and Prices metadata).

**Suggested plan ladder** (owner to confirm names and prices; limits are config):
| Plan | Max users (hard cap) | Key inclusions | AI credits / month | API calls / day | Storage |
|---|---|---|---|---|---|
| **Team** | 25 | Core CRM, pipelines, activities, web forms, import, basic reports, email sync | 5k | 25k | 50 GB |
| **Business** | 150 | + Telesales dialer, WhatsApp/SMS, automation (50 active flows), approvals, quotes, forecasting, dashboards builder | 50k | 250k | 500 GB |
| **Scale** | 500 | + Territories, custom objects (50), agents, predictive scoring, sandbox-ready metadata export, advanced audit | 200k | 1M | 2 TB |
| **Enterprise** | 1,000+ (custom) | + SAML/SCIM, dedicated cell option, 10-year history retention, custom limits, SLA | custom | custom | custom |

> **Architect's note for the owner:** flat pricing with a 5→1,000-user range means one plan could otherwise be exploited by a very large team. The **user caps per plan above** keep flat pricing viable. Confirm or adjust this before P05.

### 12.2 Implementation
Stripe Checkout for first purchase; **Customer Portal** for card, plan changes and invoices; **Stripe Tax** for global tax/VAT (GCC VAT registrations handled in Stripe settings); 14-day trial of Business without a card; proration on upgrade; downgrade at period end with a **limit check** (block if over the target plan's user cap or custom-object count, and show what to remove); dunning (Smart Retries + in-app banners at day 1/7/14; read-only mode at day 21; data retained 90 days after cancellation, then deleted with notice). The control plane processes Stripe webhooks idempotently (`cp_stripe_event` unique on event id) and pushes entitlements to the tenant's cell. **Entitlement checks** are one helper, `can(tenant, feature)` / `limit(tenant, key)`, used in guards and UI (upsell states: a locked feature shows a tasteful "Available on Business" card, never a broken button).

### 12.3 Usage metering
Counters in Redis, flushed to `cp_usage_counter` hourly: active users, AI credits (1 credit = a normalised token cost unit defined in config), API calls, storage bytes, outbound messages. A usage page is shown in Setup → Billing.

---

## §13. ENGINEERING PROCESS (how Claude Code works in this repo)

### 13.1 Repository standards
pnpm + Turborepo; `packages/config` holds shared ESLint (flat config, typescript-eslint strict, import boundaries via `eslint-plugin-boundaries`), Prettier, and tsconfig bases. Module boundary rules: `apps/*` may import `packages/*`; `packages/*` never import `apps/*`; NestJS feature modules may not import each other's internals, only their public `index.ts`; `packages/ui` has no data fetching.

### 13.2 Branching, commits, PRs
- Trunk-based on `main` (protected). Branches `feat/Pxx-<slug>`, `fix/<slug>`, `chore/<slug>`.
- **Conventional Commits** (`feat(leads): add import dry run`). Squash-merge.
- **One PR per feature task**, ideally ≤ 600 changed lines excluding generated files, lockfile and snapshots.
- PR template sections: Summary · Linked phase task · Screenshots (light + dark) for UI · Test evidence · Migration notes (expand/contract step) · Security/permissions impact · Checklist (tokens only, i18n keys, logical CSS, FLS applied, cross-tenant test, docs updated).
- Claude Code opens PRs with `gh pr create --fill --label phase:Pxx`, and in solo mode may self-merge **only after CI is green**; the owner can switch on required human review at any time.

### 13.3 Testing strategy (the pyramid is enforced by coverage gates)
| Layer | Tool | What | Gate |
|---|---|---|---|
| Unit | Vitest | formula engine, permission engine, assignment algorithms, scoring, money/currency, date/fiscal utilities, reducers | ≥ 90% lines on `packages/formula`, `packages/permissions`, `packages/query-engine`; ≥ 80% overall packages |
| Integration | Vitest + Testcontainers (Postgres 16, Redis 7) + Supertest | every endpoint: happy path, validation, permission denial, **cross-tenant denial**, FLS stripping, optimistic lock | every endpoint has ≥ 4 tests |
| DB | SQL tests | RLS audit, migration up on a snapshot, index presence for declared hot queries | must pass |
| E2E | Playwright | critical journeys per phase (listed in each phase prompt), in light + dark, with axe-core | must pass |
| Visual | Playwright screenshots | T1–T10 templates + key components, light/dark, default/compact | reviewed diffs |
| Load | k6 | §11.1 budgets on the seeded scale tenant (nightly on staging, not per PR) | alerts on regression |
| Contract | OpenAPI snapshot | drift check | must pass |

Test data: `packages/testing` provides factories (`makeLead()`, `makeTenantWithHierarchy({depth, usersPerUnit})`), a clock mock, and fake adapters.

### 13.4 Definition of Done (every task)
1. Acceptance criteria met and demonstrated in the PR (screenshots/video for UI).
2. `pnpm verify` green locally (lint, typecheck, unit, integration, rls-audit, i18n key check, logical-CSS lint, OpenAPI drift).
3. Permissions, FLS and cross-tenant tests included where data is touched.
4. Every UI state designed (loading, empty, error, no-permission) + keyboard path + axe clean.
5. Metadata and settings changes audited, and record changes produce field history where tracked.
6. Docs updated: the ADR if a decision was made, `docs/modules/<module>.md` for behaviour, the OpenAPI description strings, and user-facing help text keys.
7. No TODOs without a linked issue. No `console.log`. No disabled lint rules without a justification comment.

### 13.5 CI/CD (GitHub Actions)
- `ci.yml` on PR: install (pnpm cache) → turbo lint/typecheck/test (affected) → integration (service containers) → `db:rls-audit` → build web + api → Playwright e2e against docker-compose stack (sharded ×4) → upload traces, screenshots and coverage → OpenAPI drift → gitleaks, CodeQL (scheduled + PR), Trivy on images.
- `deploy-staging.yml` on merge to `main`: build images → push ECR → run migrations (pre-deploy task) → ECS rolling deploy → Vercel deploy (staging) → smoke e2e.
- `deploy-prod.yml` on release tag `v*` with a **manual approval environment**: same, per cell in sequence (canary cell first), with automatic rollback on a smoke failure.
- Preview: Vercel preview per PR against the staging API with a PR-scoped demo tenant.
- `nightly.yml`: k6 load against staging with the scale seed, dependency updates, backup-restore drill (weekly).

### 13.6 Local development
`docker compose up` → Postgres 16 (with extensions), Redis 7, MinIO, Mailpit, a Twilio/Meta/Stripe **fake** server (`apps/fakes`), and an OTel collector + Jaeger. `pnpm dev` runs web, api, worker and realtime with hot reload. `pnpm db:seed --scenario=agency|bank --scale=demo|load`. `.env.example` is complete and documented. A new machine reaches a working app in ≤ 15 minutes by following `README.md`.

### 13.7 Documentation set (maintained by Claude Code)
`docs/spec/MASTER_SPEC.md` · `docs/spec/ERD.md` (Mermaid, generated from Prisma + hand notes) · `docs/adr/*` · `docs/phases/*` (plan, tasks, handoff per phase) · `docs/modules/*` (behavioural docs per module) · `docs/runbooks/*` (deploy, rollback, restore, incident, breach, rotate keys, add region cell) · `docs/api/` (generated) · `CHANGELOG.md` (release notes in user language).

---

## §14. DELIVERY ROADMAP

| Phase | Weeks | Name | Main outcomes | Exit gate |
|---|---|---|---|---|
| **P00** | 1–2 | Foundation and design system | Monorepo, CI, infra-as-code skeleton, Docker dev stack, tenancy + RLS, auth core (password + Google/MS + TOTP), `@sm/ui` tokens + 25 core components, app shell, ⌘K shell, i18n + RTL pseudo-locale, fakes | Sign up → empty app shell in light/dark/compact; RLS audit green; Storybook published |
| **P01** | 2–3 | Identity, hierarchy and permissions | Users, invites, org-unit tree, profiles, permission sets/groups, OWD, sharing engine core (closure + record_share), FLS, audit log (hash chain), login history, setup audit | Permission matrix test suite (≥ 150 cases) green |
| **P02** | 3–5 | Metadata engine and core CRM | Object/field metadata, custom fields, layouts, record types, validation rules, formula engine v1, list views, Lead/Account/Contact/Opportunity/Campaign, lead conversion, record page (T2), list (T1), field history, recycle bin, search v1, mass update/transfer | Create → edit → convert → search flows e2e, at 500k-lead seed |
| **P03** | 5–6 | Lead capture, routing and data quality | CSV import wizard, web forms, email-to-lead, REST API + API keys, matching/duplicate rules + merge, assignment rules (all methods except territory), queues, SLA timers, rules-based scoring, lead recycling | Import 100k rows with dedupe + routing in < 60 s on staging |
| **P04** | 6–7 | Pipeline and activities | Pipelines/stages/gates, Kanban (T3), activities, tasks, notes, meetings (manual), timeline, Home "Today" (rep), notifications (in-app + email), follow records | Rep daily-loop e2e; Kanban at 10k open opps smooth |
| **P05** | 7–8 | Reports v1, billing, onboarding → **MVP launch** | Report types, tabular + summary reports, 6 chart types, dashboards v1, Stripe plans + entitlements, onboarding wizard, demo seeds, MVP hardening (perf, a11y, security review) | **MVP GA gate** (§14.1) |
| **P06** | 9–12 | Telesales and channels | CTI adapter + Twilio softphone, dialer lists (preview/progressive), dispositions, agent states, DNC and calling windows, wallboard, Gmail/Outlook sync, email templates, WhatsApp Cloud API, SMS, unified inbox, calendar sync, Meta/LinkedIn lead ads | 50-agent simulated floor on fakes; WhatsApp 24 h rules verified |
| **P07** | 12–15 | AI layer | AI gateway, metering, prompt registry, NBA + My queue, predictive scoring (cold start + ML service), call/thread summaries, drafting, deal risk, NL reports, assistant (⌘J), agents + approval inbox, AI settings and usage dashboard | AI eval suite (≥ 200 golden cases) passing thresholds; zero FLS leaks in red-team tests |
| **P08** | 15–17 | Automation | Flow builder (T8), triggers, logic/actions, runtime, versioning, test mode, run history, governor limits, templates gallery, **outbound webhooks infrastructure** | 15 template flows run e2e; recursion and limit tests green |
| **P09** | 17–20 | Revenue: approvals, CPQ-lite, contracts, orders | Approval processes engine + inbox, products, price books, opportunity products, quotes + PDF + discount approvals, contracts, orders, Xero/QuickBooks handoff | Quote → approval → accepted → order → invoice e2e |
| **P10** | 20–22 | Territories, forecasting, performance | Territory models + rules + preview + access, forecasting (types, categories, adjustments, snapshots, coverage), quotas, leaderboards, badges, streaks, challenges, manager Home | Forecast roll-up correctness suite; territory re-assignment preview diff |
| **P11** | 22–24 | Analytics and customisation depth | Drag-and-drop report builder, matrix, bucket fields, summary formulas, scheduling, dynamic dashboards, **custom objects**, roll-up summary fields, formula fields in filters, metadata package export/import | Build a custom object with roll-ups and report on it e2e |
| **P12** | 24–26 | Enterprise, scale and launch | SAML/OIDC SSO + SCIM, OAuth connected apps, bulk API, SDK, GDPR/DSAR + retention, SIEM stream, second cell (me-central-1) + tenant routing, OpenSearch adapter, PWA install + offline + push, load test at full scale, pen-test fixes, docs site | **v1 GA gate** (§14.2) |

### 14.1 MVP GA gate (end of week 8)
Self-serve signup → Stripe trial → onboarding → import → routing → work leads → convert → Kanban → close → basic reports and dashboards, all working in production (eu-central-1 cell). §11.1 budgets met at the 800-rep seed with 500k leads. Zero critical/serious axe violations. RLS audit and cross-tenant suite green. External security review of auth and tenancy done, with no high findings open. The demo tenants are ready.

### 14.2 v1 GA gate (end of week 26)
All §2.1 modules shipped. The load test at full scale (§11.2) passes. The pen test has no open critical/high findings. Two cells live. Backup-restore drill passed. Docs site and API reference are public. Runbooks complete.

---

## §15. SEED AND DEMO DATA

`packages/db/seed` with a deterministic faker seed. Scenarios:
1. **"Pixelcraft Studio (Demo)"**, a 5-rep digital agency (global, USD): 1 owner/admin, 1 manager, 4 reps (with 1 dual-role). 2,000 leads, 400 accounts, 900 contacts, 150 opportunities across 1 pipeline (Discovery → Proposal → Negotiation → Won/Lost), 10k activities over 12 months, 3 web forms, 2 dashboards.
2. **"Aurelia Bank Retail Sales (Demo)"**, an 800-rep bank-style telesales floor (QAR corporate currency + USD, Asia/Qatar timezone plus multi-timezone users): hierarchy Company → 4 Regions → 20 Branches → 80 Teams (10 reps each) + a central telesales hub; profiles (Admin, Director, Branch Manager, Team Leader, Telesales Agent, Relationship Officer, Compliance Viewer); 3 pipelines (Credit Cards, Personal Finance, Accounts & Deposits) with bank-style stages (New Application → Documents Pending → Credit Check → Approved → Disbursed/Issued | Declined); products such as credit card tiers and personal-finance brackets (generic, no real bank brands); **500k leads** (demo scale) or **5M leads** (`--scale=load`), 60k accounts, 40k opportunities, 3M activities (demo) / 50M (load); dialer lists, dispositions and a live-looking wallboard; quotas and a running monthly contest; territories by region/branch.
The seed also creates `demo+agency@salesmaker.app` / `demo+bank@salesmaker.app` users (staging only) and a "Reset demo" admin action (staging only).

---

## §16. GLOSSARY
**OWD:** org-wide default sharing. **FLS:** field-level security. **SMQ:** SalesMaker Query JSON AST. **Cell:** a regional deployment stack. **NBA:** next-best-action. **Disposition:** the outcome code of a call. **Path:** the stage guidance bar. **Compact layout:** highlight fields. **Record type:** business-process variant of an object. **Territory model:** a set of territories plus assignment rules. **Run-as user:** the identity an integration or agent acts as. **Governor limits:** per-tenant resource caps for automation. **Expand/contract:** zero-downtime migration pattern (add → backfill → switch → remove).

---
*End of MASTER_SPEC. Phase prompts P00–P12 follow as separate messages.*
