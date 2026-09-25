# Authentication and sessions

Spec: §6.1, §3.6, §10.2 · ADRs: 0005, 0006 · Code: `apps/api/src/auth`, `apps/web/src/server`, `@sm/integrations`

## Who does what

| Piece                                  | Responsibility                                                                                                                                                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cell API** (`apps/api`)              | Passwords, lockout, sessions, refresh rotation, TOTP, email tokens, OIDC with Google/Microsoft. Cookie-less: tokens in, tokens out, JSON only. Pre-auth routes name the workspace with `x-sm-tenant-id`. |
| **Web BFF** (`apps/web/src/server`)    | Resolves the host to a tenant and cell through the control plane, relays auth calls to that cell, and **owns every cookie**. It is the only thing a browser talks to.                                    |
| **Control plane** (`apps/control-api`) | Host → tenant → cell resolution, slug reservations, activation, "find my workspaces" (always 202; email HMACs only).                                                                                     |

The `/auth/*` routes are internal (§10.2): never exposed to API keys or connected apps.

## Passwords and lockout

- argon2id with 64 MB memory, 3 iterations and parallelism 1. At least 12 characters. A k-anonymity breach check
  (fake in dev and CI) that **fails open** if the breach API is down (§11.3).
- Lockout: 10 failures for an address within 15 minutes locks it for 15 minutes, doubling with each further lockout
  that day (capped at 24 h). Attempts are keyed by the email HMAC, so unknown addresses behave like known ones. A
  locked response is `423 account_locked` with `Retry-After`.
- Email verification links last 24 hours and reset links 30 minutes. Both are single-use: the token is consumed with a
  conditional update, so a concurrent second use fails.

## Sessions

- Access token: an EdDSA JWT (15 minutes, `kid` rotation via `AUTH_JWT_PREVIOUS_KEYS`), kept **only in page memory**.
- Refresh token: opaque, 30 days, stored as a hash, **rotated on every use**. Presenting a used token revokes the
  whole family (reuse detection); the revocation commits even though the request fails.
- In the browser the refresh token lives in an httpOnly, `SameSite=Lax` cookie on the workspace host only
  (`__Host-sm_rt` over HTTPS). The BFF's POST routes accept only an exact same-origin `Origin` header (CSRF).
- The page shares one in-flight refresh and serialises refreshes across tabs with a Web Lock, so two tabs never
  present the same single-use token.

## Two-step verification (TOTP)

RFC 6238 (SHA-1, 30 s, 6 digits), one step of drift, and **replay protection**: a factor records the last step it
accepted, so a code can never be used twice. Ten single-use recovery codes are issued on confirmation. Secrets are
encrypted with SecretBox (AES-256-GCM, key id prefix, rotation via `SECRETS_PREVIOUS_KEYS`). A password or provider
sign-in that needs the second factor returns `mfa_required` with a short-lived `mfaToken`.

## Google and Microsoft (OIDC)

- Authorization code + PKCE (S256), `state` and `nonce`, via `openid-client`. Redirect URIs are allow-listed to our
  own callbacks: `{slug}.{base}/auth/callback/{provider}` for sign-in and `{base}/signup/callback/{provider}` for
  sign-up. The BFF keeps the PKCE values in a ten-minute httpOnly cookie.
- **No auto-join** (§6.1): a provider identity signs in only when it is already linked, or when its verified email
  matches an existing user of that workspace. Otherwise `403`, shown as "no account in this workspace".
- Sign-up with a provider creates an active organisation from the apex, revokes the session the cell opened there, and
  continues on the new workspace's host, where the browser signs in with a second provider round trip. Session
  cookies are host-only, so no token ever crosses hosts.
- Before real providers are enabled: see the redirect-URI follow-up in `docs/phases/P00-notes.md`.

## Sign-up and activation

`POST /auth/signup` on the chosen cell reserves the slug with the control plane (idempotently, keyed by the client's
`Idempotency-Key`), provisions `tenant_settings` and the owner in one tenant transaction, and emails a verification
link. If provisioning fails the reservation is released. When the owner verifies, the cell activates the tenant with
the control plane **before** consuming the token: an outage leaves the link usable.

## Testing

- Unit and integration tests in `apps/api/test` (Testcontainers Postgres and Valkey), including cross-tenant denial.
- BFF behaviour in `apps/web/test` (fake fetch, no network).
- End to end in `apps/web/e2e`: password sign-up, Google sign-up, TOTP and recovery codes, against the fakes.
