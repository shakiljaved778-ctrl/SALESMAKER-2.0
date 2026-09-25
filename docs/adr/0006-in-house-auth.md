# ADR-0006: In-house authentication

- **Status:** Accepted (locked decision #27 in MASTER_SPEC §1.4)
- **Date:** 2026-09-25
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §6.1

## Context

Identity must support password, Google/Microsoft SSO, enterprise SAML/OIDC, SCIM and MFA, with per-tenant policy (IP ranges, login hours, enforced SSO/MFA). It must also integrate with cell routing.

## Decision

Build auth in-house using `argon2` (argon2id 64 MB/3/1), `openid-client`, `@node-saml/node-saml`, `otplib` and `@simplewebauthn/server`. Access JWTs last 15 min (EdDSA, `kid` rotation), with rotating refresh tokens and reuse detection. API keys are `sm_live_`/`sm_test_`, stored hashed. OAuth 2.0 connected apps with PKCE arrive in P12. Social SSO links just-in-time only to invited users, unless the admin has verified the domain.

## Consequences

- Full control over tenancy-aware routing and per-profile policy, and no per-MAU vendor cost.
  − Security-critical code we own: external review of auth is part of the MVP gate, plus a pen test in P12.

## Alternatives rejected

Auth0/Clerk/Cognito (per-MAU cost at 1,000-user tenants, residency constraints, less control over SAML/SCIM per tenant).

> Changing this decision requires the owner's approval (§0.3) and a new superseding ADR.
