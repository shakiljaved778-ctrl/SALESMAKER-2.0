# P00 — Foundation and design system: plan

- **Status:** PLANNING. Awaiting owner approval (§0.2 step 2). No application code is written until this plan is approved.
- **Weeks:** 1–2 · **Spec:** §3, §4.1, §6.1, §9, §10.5, §13, §14 (P00 row) · **ADRs:** 0001–0006, 0015–0018, 0024, 0028
- **Exit gate (§14):** sign up → empty app shell in light / dark / compact; `db:rls-audit` green; Storybook published.

## 0. Assumptions pending owner answers

This plan assumes the proposed answers to the questions in `docs/spec/OPEN_QUESTIONS.md` that block P00.
Each row lists what changes if you answer differently.

| Q | Assumed answer | Tasks affected if different |
|---|---|---|
| 2 | The control plane stores only `HMAC-SHA256(pepper, lower(email))`, never the email address. "Find my workspaces" emails the list, so tenant membership can't be enumerated. | T06, T12 |
| 3 | Staging runs on AWS ECS, not Railway. P00 ships the Terraform skeleton only; no environment is deployed. | T24 |
| 4 | No `REPO_SCAFFOLD.md` exists, so the tree is derived from §3.3. | T01 |
| 5 | `--text-disabled` is exempt from the contrast test (as in WCAG 1.4.3). Lost chips render graphite-600 text on graphite-100. | T13 |
| 7 | Every task is committed on the session branch, one commit per task, with a PR per task or per batch, as you prefer. `feat/P00-*` branches are used only if you allow pushing to them. | all |
| 8 | Fonts are OFL (approved). MinIO and ClamAV run only as out-of-process dev/infra containers. **Valkey 8** (BSD) replaces Redis locally; ElastiCache uses the Valkey engine. BullMQ and ioredis are protocol-compatible. | T03, T24 |

## 1. Scope

**In P00:**
- Monorepo, shared config and the `pnpm verify` gate.
- CI and security scans.
- Docker dev stack and the `apps/fakes` server.
- Terraform skeleton.
- Tenancy: roles, RLS helper, `withTenant`, the Kysely bridge and `db:rls-audit`.
- Skeletons for the control plane and the cell API.
- Auth core: password, email verification and reset, sessions with rotating refresh tokens, TOTP MFA, and Google/Microsoft OIDC (against fakes).
- Minimal signup that provisions a tenant.
- `@sm/ui` tokens plus 25 core components with Storybook.
- The app shell, ⌘K shell, i18n with pseudo-locales and RTL, T9 auth screens, and system pages.
- Integration adapter interfaces with fakes, including the AI gateway interfaces (§8, "stubbed from P00").

**Deferred:**
- Passkeys (WebAuthn) and invitations → P01. The P00 row lists TOTP only.
- Login history, audit log and setup audit → P01.
- Full onboarding wizard, billing and plans → P05.
- Any CRM object → P02.

## 2. Task breakdown

Each task is one PR, ≤ ~600 changed lines excluding generated files and lockfiles. Tests come first where the logic is non-trivial.

| # | Task (Conventional Commit scope) | Contents | Depends on |
|---|---|---|---|
| T01 | `chore(repo): monorepo scaffold` | pnpm workspace + Turborepo; `packages/config` (ESLint flat config, typescript-eslint strict, `eslint-plugin-boundaries`, the **logical-CSS ban rule**, `no-console`, Prettier, tsconfig bases with `strict` + `noUncheckedIndexedAccess`); `.nvmrc` (Node LTS); `pnpm verify` script; README quick-start; PR template (§13.2 sections); CODEOWNERS. Exact tool versions are pinned and recorded in an ADR-0002 addendum. | — |
| T02 | `ci: pipeline and security scans` | `ci.yml` (install with pnpm cache → turbo lint/typecheck/test on affected packages → build); gitleaks; CodeQL; Dependabot config; `pnpm audit` gate (high+). Later tasks add jobs as the pieces arrive. | T01 |
| T03 | `chore(dev): docker compose stack` | Postgres 16 image with `pgcrypto`, `pg_trgm`, `citext`, `pgvector`, `btree_gin`, `pg_partman`; Valkey; MinIO; Mailpit; OTel collector + Jaeger; `.env.example` fully documented. | T01 |
| T04 | `feat(db): roles, RLS helper, platform schema` | `packages/db`: Prisma setup; SQL migrations for the roles `sm_migrator`/`sm_app`/`sm_readonly_reports`/`sm_support`, `uuid_generate_v7()`, `enable_tenant_rls(regclass)`, and the P00 cell tables (§3 below). Migrations run as `sm_migrator`, the app runs as `sm_app`. | T03 |
| T05 | `feat(db): withTenant + Kysely bridge + rls-audit` | Prisma client extension `withTenant(ctx, fn)` (interactive transaction, `set_config` for tenant and user). Kysely runs on the same transaction through a Prisma-backed driver. `db:rls-audit` script plus CI job. **Spike first:** prove that the bridge works through PgBouncer in transaction mode. If it fails, stop and raise it, because ADR-0004 depends on it. | T04 |
| T06 | `feat(control-api): skeleton + tenant directory` | NestJS/Fastify app with its own Postgres DB; tables `cp_tenant`, `cp_tenant_domain`, `cp_user_routing(email_hmac)`, `cp_cell`; slug reservation, tenant resolve-by-slug, "find my workspaces"; service-to-service auth to cells (signed JWT). | T04 |
| T07 | `feat(contracts): base contracts + OpenAPI` | `packages/contracts`: problem+json, ids (UUIDv7), money `{amount,currency}`, cursor pagination, error codes; zod → OpenAPI 3.1 generator; committed snapshot + **drift check** in CI. | T01 |
| T08 | `feat(api): cell API skeleton` | `apps/api` NestJS on Fastify: request-id, pino with PII-redaction middleware, OTel spans (`tenant.id`, `user.id`, `route`, `db.statement.count`), zod validation pipe, RFC 9457 filter, `/health`, TenantContext/UserContext guards, a Redis token-bucket rate limiter (default limits; plan-driven in P05), and cell identity verification. | T05, T07 |
| T09 | `feat(integrations): adapter interfaces + fakes` | `packages/integrations`: `EmailSender`, `StorageProvider`, `BreachedPasswordChecker`, `OidcProvider`; `packages/ai`: `LLMProvider`/`EmbeddingProvider`/`SpeechProvider` interfaces + `AIGateway` stub (no calls). `apps/fakes`: a fake OIDC IdP for "Google" and "Microsoft", and a fake HIBP range API. No real third-party calls. | T01 |
| T10 | `feat(auth): password, sessions, email verification` | argon2id (64 MB/3/1), min 12 characters, breached check via adapter, lockout after 10 failures in 15 min with backoff; EdDSA access JWT (15 min, `kid` rotation) + rotating refresh token (httpOnly/Secure/Lax, 30 days sliding, **reuse detection revokes the chain**); verify-email and forgot/reset flows via `EmailSender` → Mailpit. | T08, T09 |
| T11 | `feat(auth): TOTP MFA + recovery codes` | Enrol, verify and challenge; 10 hashed recovery codes; MFA step inside login. | T10 |
| T12 | `feat(auth): Google/Microsoft OIDC` | `openid-client` with PKCE and state/nonce. Signup through a provider, or link to an existing user (for invited users only; verified-domain auto-join arrives with invites in P01). Tested against the fake IdP. | T10 |
| T13 | `feat(tenancy): signup provisions a tenant` | Signup (email + password or OIDC, org name, slug, region = eu-central-1, currency, timezone) → reserve the slug in the control plane → create `tenant_settings` and the owner user in the cell → verify email → activate. Idempotent via `Idempotency-Key`, with compensation if the cell step fails. | T06, T10, T12 |
| T14 | `feat(ui): design tokens + themes + density` | `packages/ui/src/tokens/*.css`: every §9.2–9.5 primitive and semantic token, the categorical palette, type scale, spacing/radius/elevation/motion/z-index; Tailwind v4 `@theme` mapping; `data-theme` and `data-density`; `tokens.contrast.test.ts` (exemptions per Q5). | T01 |
| T15 | `feat(ui): Storybook + RTL/pseudo-locale + visual harness` | Storybook with toolbar globals for theme × density × `dir` × locale (`en`, `en-XA`); token documentation pages; Playwright visual-snapshot runner; published to **GitHub Pages** from CI (Chromatic is a paid service and is not used). | T14 |
| T16 | `feat(ui): form controls` | Button (all variants, including `ai`), IconButton, Input, Textarea, Checkbox, Radio, Switch, FormField (label above, required `*` + `aria-required`, helper/error). | T15 |
| T17 | `feat(ui): selection and display` | Select, Combobox (searchable when > 7 options, async slot), StatusChip/Badge, Avatar (with initials fallback and presence dot), Tooltip, Kbd, Separator, Card. | T16 |
| T18 | `feat(ui): overlays and navigation` | Popover/HoverCard, DropdownMenu, Dialog (sm/md/lg/xl, dirty-form confirm hook), Sheet, Tabs (underline + counts), Toast (bottom-start, max 3, Undo action). | T16 |
| T19 | `feat(ui): feedback + command palette` | Banner, EmptyState, Skeleton, and the CommandPalette component (sections, fuzzy match highlighting, keyboard navigation). **25 components in total** across T16–T19; every one has stories for each variant × state × theme × density plus an RTL story. | T18 |
| T20 | `feat(i18n): next-intl + pseudo-locales + key check` | `packages/i18n`: namespaced `en` messages, generated `en-XA` (accented, +30%), and an RTL pseudo-locale (English strings with `dir=rtl`); `i18n:check` (missing or unused keys, no string concatenation); wired into `pnpm verify`. | T01 |
| T21 | `feat(web): Next.js app skeleton` | App Router with RSC; Inter Variable + JetBrains Mono via `next/font` (Plex Arabic declared, not loaded); no-flash theme script; tenant resolution `{slug}.salesmaker.app` (locally `{slug}.localhost:3000`) → control-api → cell URL (never hard-coded); BFF route handlers for auth cookies. | T13, T14, T20 |
| T22 | `feat(web): T9 auth screens` | Sign in, Sign up (with org creation), Verify email, Forgot/Reset password, MFA challenge, SSO redirect, "Find my workspaces", and an Accept-invite placeholder route. Every UI state is designed. | T21 |
| T23 | `feat(web): app shell + ⌘K shell + system pages` | Dark sidebar (232/56, `[` toggle, nav items rendered as placeholders), top bar (breadcrumbs, search trigger, + New, AI button, bell, avatar menu with theme/density), workspace-tab bar (empty state), ⌘K with navigation and theme/density commands, `?` shortcut sheet, empty Home with a teaching empty state; 404, 403, 500 and maintenance pages. | T19, T22 |
| T24 | `chore(infra): Terraform skeleton` | `infra/terraform`: `cell` module (VPC, RDS PG16 Multi-AZ + replica, ElastiCache Valkey, S3 + KMS, ECS services, ALB) and `control-plane` module; one env stub `staging-eu-central-1`; `terraform validate` + `tflint` in CI. Nothing is applied in P00. | T02 |
| T25 | `test(e2e): exit-gate journeys` | Playwright + axe against the compose stack: sign up → verify (Mailpit) → shell in light/dark/compact; Google-fake signup; login with TOTP; RTL smoke; visual baselines for T9 and the shell. CI job sharded. | T23 |
| T26 | `docs: P00 docs + handoff` | `docs/spec/ERD.md` (P00 tables, Mermaid), `docs/modules/{tenancy,auth,design-system}.md`, runbook stubs (`deploy`, `rotate-keys`, `add-region-cell`), `P00-handoff.md`, ROADMAP update. | all |

**Sequence:** T01 → (T02, T03, T07, T09, T14, T20 in parallel) → T04 → T05 → (T06, T08) → T10 → (T11, T12) → T13 → T15 → T16 → (T17, T18) → T19 → T21 → T22 → T23 → T24 → T25 → T26.

## 3. Data model diff (all new)

**Control plane DB** (not tenant-scoped; excluded from the RLS audit by an explicit allow-list):
- `cp_cell(id, region, api_base_url, status)`
- `cp_tenant(id uuidv7, slug citext unique, cell_id, status {PENDING, ACTIVE, SUSPENDED}, plan_code, created_at)`
- `cp_tenant_domain(tenant_id, host unique)`
- `cp_user_routing(email_hmac bytea, tenant_id, PRIMARY KEY(email_hmac, tenant_id))`: no plaintext email (Q2)
- `cp_idempotency_key(key, request_hash, response, expires_at)`

**Cell DB.** Every table has forced RLS through `enable_tenant_rls`, `tenant_id` leads every PK and index, and the §4.1 standard columns are present where they apply:
- `tenant_settings(tenant_id PK, name, slug, region, corporate_currency char(3), default_locale, default_timezone, fiscal_year_start_month, metadata_version, perm_version, logo_file_id null)`
- `user(tenant_id, id, email citext, email_verified_at, name, locale, timezone, theme {light,dark,system}, density {comfortable,default,compact}, status {PENDING,ACTIVE,DISABLED}, …std)`, with a unique index on `(tenant_id, email)`
- `user_identity(tenant_id, id, user_id, provider {password,google,microsoft}, subject, password_hash null, …)`, unique on `(tenant_id, provider, subject)`
- `session(tenant_id, id, user_id, created_at, last_seen_at, ip, user_agent, revoked_at)`
- `refresh_token(tenant_id, id, session_id, family_id, token_hash, parent_id, used_at, expires_at, revoked_at)`
- `mfa_factor(tenant_id, id, user_id, type {totp}, secret_enc, confirmed_at)` and `mfa_recovery_code(tenant_id, id, user_id, code_hash, used_at)`
- `auth_token(tenant_id, id, user_id, purpose {verify_email,reset_password}, token_hash, expires_at, used_at)`
- `auth_attempt(tenant_id, user_id null, email_hash, ip, success, at)`, used for lockout; it becomes `login_history` in P01
- `idempotency_key(tenant_id, key, request_hash, response_status, response_body, expires_at)`
- Global (allow-listed, no `tenant_id`): `currency(code, name, minor_units)`

Secrets such as TOTP secrets use envelope encryption (`pgcrypto` + a key id). The local KMS is a static dev key; AWS KMS arrives with the Terraform work.

## 4. API diff (all new; zod contract + OpenAPI entry + integration tests for each)

**control-api:**
- `POST /cp/v1/tenants/reserve` (cell-to-cp only)
- `POST /cp/v1/tenants/{id}/activate` (cell-to-cp only)
- `GET /cp/v1/tenants/resolve?host=` (public, cached)
- `POST /cp/v1/workspaces/find {email}`: always returns 202 and emails the list

**Cell API.** Auth endpoints live under `/auth/*`, which is part of the internal surface (§10.2) and never exposed to API keys:
- `POST /auth/signup`
- `POST /auth/verify-email`
- `POST /auth/login`, which returns a `mfa_required` challenge when needed
- `POST /auth/mfa/challenge`
- `POST /auth/refresh`
- `POST /auth/logout`
- `POST /auth/password/forgot`
- `POST /auth/password/reset`
- `POST /auth/mfa/totp/enroll`
- `POST /auth/mfa/totp/confirm`
- `GET /auth/oidc/{google|microsoft}/start`
- `GET /auth/oidc/{provider}/callback`
- `GET /v1/me`
- `PATCH /v1/me/preferences` (theme, density, locale, timezone)
- `GET /health`

Every endpoint gets ≥ 4 integration tests. For the tenant-scoped ones (`/v1/me*`, sessions), one of them is a cross-tenant test: a tenant-A token used against tenant B's host → **404**.

## 5. UI screens (P00 inventory, §9.15)

- T9: Sign in, Sign up (+ org), Verify email, Forgot password, Reset password, MFA challenge, SSO redirect, Find workspaces, and the Accept-invite route (placeholder until P01).
- Shell: empty Home, the avatar menu's Display settings (theme and density), and the ⌘K shell.
- System pages: 404, 403 (with "request access"), 500 and maintenance. The offline and plan-limit pages arrive in P12 and P05.

## 6. Test plan

- **Unit (Vitest):**
  - argon2 parameters
  - password policy
  - lockout/backoff maths
  - JWT sign/verify with `kid` rotation
  - refresh rotation and **reuse detection**
  - TOTP window and recovery codes
  - email HMAC normalisation
  - slug rules
  - token contrast
  - logical-CSS lint rule fixtures
  - i18n key checker
- **Integration (Vitest + Testcontainers PG16/Valkey):**
  - `withTenant` isolation: a tenant-A transaction can't see B's rows, and inserting with a wrong `tenant_id` fails WITH CHECK
  - `sm_app` can't bypass RLS
  - `db:rls-audit` fails on a fixture table without a policy
  - the Kysely bridge sees `app.tenant_id`
  - every auth endpoint: happy path, validation, denial, cross-tenant and idempotency
  - signup compensation
- **E2E (Playwright + axe):** the exit-gate journeys in T25, run in light and dark with zero serious or critical violations.
- **Visual:** T9 screens and the shell in light/dark × default/compact, plus the RTL smoke test.
- **Contract:** OpenAPI snapshot drift.

## 7. Risks

1. **Prisma ↔ Kysely shared transaction (ADR-0004).** The riskiest assumption. It is spiked first in T05; the fallback, if it fails, would need an ADR change and your approval.
2. **Tailwind v4 + shadcn.** Must be verified with `@theme` tokens and logical utilities. The component sources are forked into `@sm/ui`, so upstream changes don't break us.
3. **Scope vs two weeks.** 26 tasks is a lot. If time runs short, cut component story breadth (keeping at least the default + dark + RTL stories) before cutting any test or gate, as §1.5 requires.
4. **Cross-subdomain auth locally.** `*.localhost` cookies behave differently across browsers. The Playwright project pins Chromium and host mapping.
5. **Session design across Vercel and the regional API.** The BFF holds the httpOnly refresh cookie on the tenant subdomain and the access token stays in memory. CORS is locked to tenant origins. This needs a security review before MVP GA (the §14.1 external auth review).

## 8. Definition of Done for P00

Every task meets the §13.4 Definition of Done, and the exit gate is shown with evidence:
- a Playwright video of sign-up to shell in light, dark and compact
- the CI log of `db:rls-audit` passing
- the Storybook URL

Finally, `P00-handoff.md` is written and the ROADMAP is updated.
