# P00 working notes (input for the handoff)

Deviations from the plan or spec, known issues and follow-ups, recorded as they happen.

## Deviations (each with its reason)

- **SeaweedFS instead of MinIO** for local S3 (T03). MinIO no longer publishes Docker images, and it is AGPL.
  SeaweedFS is Apache-2.0 and S3-compatible. Production still uses AWS S3.
- **`docker-compose.sandbox.yml`** (T03). Restricted networks such as this build sandbox cannot `apt-get` pg_partman
  inside the Postgres image build. The override boots the upstream pgvector image. The real image is built in CI (`db` job).
- **Extensions live in an `extensions` schema** on the database `search_path` (T05). Prisma's drift check resets
  `public` in its shadow database, and that must not drop the extensions.
- **Extra packages `@sm/server-kit` and `@sm/testing`**. server-kit is the NestJS/Fastify pipeline shared by `apps/api`
  and `apps/control-api`, which would otherwise be duplicated. `@sm/testing` (listed in §3.3) hosts the fake third-party
  servers, so tests and `apps/fakes` share them (apps cannot import apps).
- **Auth routes are POST and cookie-less** (T10–T12). The plan listed `GET /auth/oidc/*/start|callback`. Because the web
  BFF owns every cookie, the API takes and returns tokens and OIDC state in JSON instead.
- **`app_current_tenant_id()` uses `NULLIF(..., '')`** (T04). A pooled connection reports `''` rather than NULL once a
  transaction-local setting has ended, and `''` must never be cast to uuid.
- **Version pins** (ADR-0002 addendum): TypeScript 6.0.3 (typescript-eslint does not support 7 yet) and Prisma 7.10.0
  (npm `latest` is an 8.0 release candidate).
- **No theme script** (T21). The plan listed a no-flash theme script. Theme, density, locale and direction are
  rendered on `<html>` from preference cookies, and `system` resolves in CSS (`prefers-color-scheme` in `tokens.css`),
  so the first paint is already right with no inline script and no CSP nonce.
- **Next.js 16** (T21). The current stable release. Middleware is not used: tenant resolution happens per request in
  Server Components and BFF route handlers, through one cached `TenantDirectory`.
- **`@sm/ui` client boundaries** (T21). Interactive component modules declare `'use client'`, guarded by
  `test/client-boundary.test.ts`, so Server Components can import from the barrel.
- **Auth screens are client forms over BFF routes** (T22). OIDC runs through GET route handlers
  (`/auth/start|callback/{provider}` on a workspace, `/signup/callback/{provider}` on the apex) that keep PKCE state in a
  ten-minute httpOnly cookie. Google/Microsoft sign-up creates the organisation from the apex, revokes the session the
  cell opened there at once, and continues on the new workspace's own host with a second provider round trip: session
  cookies are host-only by design, so no token is handed across hosts. The refresh cookie follows §6.1
  (`SameSite=Lax`); the BFF's exact-Origin check is the CSRF defence.
- **Refreshes are serialised in the browser** (T22). Refresh tokens are single-use with reuse detection, so the page
  shares one in-flight refresh and serialises across tabs with a Web Lock; each request then carries the latest cookie.
- **Next.js telemetry is off** in the web scripts (no third-party calls from CI or dev machines).

## Known issues and follow-ups

- **Microsoft multi-tenant issuer.** The real `common`/`organizations` endpoints issue tenant-specific `iss` values, which
  strict issuer validation rejects. Before real Microsoft sign-in is enabled, add tenant-aware issuer validation to
  `OpenIdConnectProvider`. The fakes use a fixed issuer.
- **Access tokens are stateless for up to 15 minutes.** Revoking a session takes effect at its next refresh. A
  per-request session check can be added if §6.1 "remote sign-out" needs to be immediate.
- **Rate limits.** P00 has the pre-auth per-IP limit. Per-tenant and per-user limits driven by the plan arrive with
  entitlements in P05.
- **Control plane database role.** `apps/control-api` connects as the database owner. A least-privilege runtime role
  like the cell's `sm_app` should be added with the Terraform work.
- **Licences to note.** nodemailer is MIT-0 (more permissive than MIT). The OFL fonts, Valkey and SeaweedFS were
  approved or chosen under the v1.2 answers.
- **Dev-only MPL-2.0 tooling.** `axe-core` / `@axe-core/playwright` are MPL-2.0. The spec names axe-core (§3.2), and it is
  test tooling only: never shipped at runtime, so it is outside §0.3's runtime-dependency rule.
- **Storybook visual baselines** were captured in the build container. CI treats visual diffs as reviewed, not blocking
  (§13.3), because font rendering can differ slightly between environments. The axe pass is blocking.
- **Tailwind needs literal class names.** A story built `text-${name}` dynamically and the classes were never
  generated; the visual baseline caught it. Components must use literal class maps.
- **Client IP behind the BFF.** Auth calls reach the cell from the web tier, so the cell's pre-auth per-IP limit sees
  the BFF's address. Before GA, the BFF must forward the client IP in a header the cell trusts only from the web tier
  (a service token, like cell-to-control-plane calls), and the lockout must key on it.
- **Content-Security-Policy** arrives with the app shell (T23), once every script and style source is known. Baseline
  headers (nosniff, frame DENY, referrer and permissions policies) are set now.
- **Fonts ship the Latin subset only** (English UI in v1). Add latin-ext and the Arabic face when those locales ship.
- **Google/Microsoft redirect URIs.** Workspace sign-in uses `{slug}.{base}/auth/callback/{provider}`. The fakes accept
  any redirect URI, but the real providers need every redirect URI registered, and per-workspace hosts cannot be. Before
  real providers are enabled, route OIDC through one registered apex callback with a signed, single-use handoff to the
  workspace host (a security-review item alongside the BFF session design).
- **Refresh races across devices or retries.** Web Locks cover tabs in one browser. A network retry of a refresh whose
  response was lost still looks like reuse. Consider a short server-side grace window for the just-rotated token (§6.1
  reuse detection stays) before GA.
