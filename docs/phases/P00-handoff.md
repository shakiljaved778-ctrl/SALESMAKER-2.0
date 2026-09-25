# P00 handoff: foundation and design system

Plan: [P00-plan.md](P00-plan.md) · Tasks: [P00-tasks.md](P00-tasks.md) (26/26) · Deviations and follow-ups:
[P00-notes.md](P00-notes.md) · Branch: `claude/great-heisenberg-pbhzs3` (one Conventional Commit per task)

## Exit gate

| Gate (§14)                                          | Evidence                                                                                                                                                                                                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign up → empty app shell in light / dark / compact | `apps/web/e2e/signup-shell.spec.ts`: apex sign-up → Mailpit verification link → sign-in → Home in light, dark and compact, with axe on every step and visual baselines. Also run by hand against the local stack, with screenshots reviewed. |
| RLS audit green                                     | `db · migrate · rls-audit · drift` CI job: every tenant table has forced RLS and the exact `tenant_isolation` policy; the Prisma schema matches the migrations.                                                                              |
| Storybook published                                 | Built and axe-checked in CI on every push (120 story × variant checks). Publishing to GitHub Pages runs from `main`, so it goes live when this branch merges.                                                                                |

## What was built

- **Monorepo and CI.** Turborepo + pnpm, strict TypeScript, ESLint with `sm/logical-css` and `sm/design-tokens`,
  Prettier, Vitest; CI jobs for verify, gitleaks, db (migrate, rls-audit, drift), Storybook (axe blocking, visual
  reviewed), Terraform (fmt, validate, tflint) and sharded e2e. CodeQL and Dependabot.
- **Local stack.** Docker Compose: Postgres 16 with every §3.2 extension, Valkey 8, SeaweedFS, Mailpit, OTel + Jaeger;
  `pnpm setup:dev` and `pnpm db:setup`; fake Google/Microsoft IdPs and a fake breach API in `apps/fakes`.
- **Tenancy.** Roles `sm_migrator` / `sm_app` / `sm_readonly_reports` / `sm_support`, forced RLS through
  `enable_tenant_rls()`, `withTenant()` with Prisma and Kysely sharing one transaction (ADR-0004 spike proven),
  `db:rls-audit`. See [tenancy](../modules/tenancy.md).
- **Control plane.** Tenant directory, host resolution, slug reservation and activation, "find my workspaces",
  EdDSA service tokens between cells and the control plane, idempotency.
- **Auth core.** Passwords (argon2id, breach check, lockout), rotating refresh tokens with reuse detection, TOTP with
  replay protection and recovery codes, email verification and reset, Google/Microsoft OIDC with no auto-join,
  self-serve signup. See [auth](../modules/auth.md).
- **Design system.** §9 tokens with contrast tests, Tailwind v4 theme, 27 components with stories in five variants.
  See [design system](../modules/design-system.md).
- **i18n.** ICU catalogues, `en-XA` and `ar-XB` pseudo-locales, a catalogue check in `pnpm verify`.
- **Web app.** Next.js 16: tenant resolution through the control plane, BFF route handlers that own the session
  cookie, the T9 auth screens, the app shell (sidebar, top bar, tab bar, ⌘K, `?` sheet, `G then …`), system pages
  (404, 403, 500, maintenance), a per-request CSP nonce, display preferences saved to the profile.
- **Infrastructure as code.** Terraform modules for the network, a cell and the control plane, plus a staging stub.
  Nothing is applied.
- **Docs.** [ERD](../spec/ERD.md), module docs, [runbook stubs](../runbooks/README.md).

## Tests

387 unit and integration tests (api 60, control-api 18, web 42, ui 163, db 26, server-kit 24, config 19, contracts 11,
i18n 7, testing 7, ai 4, emails 3, integrations 3), 120 Storybook axe checks, 7 end-to-end journeys. Integration
tests run on Testcontainers Postgres and Valkey (or the compose stack), including cross-tenant denial.

## CI status

CI was red from T12 onwards, and three separate things kept it red:

1. **Prisma client ordering.** On a clean checkout, `control-api` lint ran before its Prisma client was generated
   (it passed locally, where the client already existed). A `generate` turbo task now runs first; lint, typecheck,
   test and build depend on it, and `db:setup` and the CI `db` job build through turbo.
2. **Dependency audit.** Two high advisories in transitive dependencies of the Prisma CLI (`deepmerge-ts` < 8,
   `mysql2` < 3.22). Pinned to patched versions with pnpm overrides; Prisma config loading, client generation,
   migrations and the schema-drift check were re-run against them.
3. **gitleaks false positive.** Re-padding the ROADMAP table made the P03 row's prose ("API keys, matching…")
   match `generic-api-key`. The prose-only ROADMAP is allow-listed with its reason in `.gitleaks.toml`.

On the run before the last two fixes, every other job was green: lint · typecheck · unit, both e2e shards, db
(migrate, rls-audit, drift), Storybook axe, and Terraform (fmt, validate, tflint).

## Known gaps carried into P01

- **Coverage gates are not wired yet.** §13's ≥ 90% (formula, permissions, query-engine) and ≥ 80% overall need
  `vitest --coverage` thresholds in CI. The engine packages start in P01/P02, so wire the gates as P01's first task.
- **Owner decisions still open:** Q1, Q6, Q9–Q29 in `docs/spec/OPEN_QUESTIONS.md`. Q27–Q29 are the locked tokens
  that miss the contrast rule: tertiary text, the dark danger button and input borders.
- **Security review items before GA:** the BFF session design, client IP forwarding from the BFF to the cell,
  OIDC redirect URIs for real providers, and a refresh-token grace window (all in P00-notes.md).
- **Terraform** has never been applied; its lock file is committed after the first `init` with registry access.

## For P01

Re-read CLAUDE.md, §6 (identity, hierarchy, permissions), ADR-0007 and ADR-0008, this handoff and P00-notes.md, then
write `P01-plan.md` and stop for approval.
