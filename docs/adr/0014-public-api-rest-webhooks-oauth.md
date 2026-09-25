# ADR-0014: Public API: REST + webhooks + OAuth connected apps

- **Status:** Accepted (locked decision #28 in MASTER_SPEC §1.4)
- **Date:** 2026-09-25
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §10

## Context
Integrators need a stable, metadata-driven API. GraphQL is deferred.

## Decision
A generic REST surface at `/v1` covering records, query (SMQ), search, actions, metadata and reports. zod contracts generate OpenAPI 3.1, with a CI drift check. Cursor pagination, `Idempotency-Key`, `If-Match` versions, RFC 9457 errors, and per-plan rate limits with standard headers. Outbound webhooks are HMAC-signed (`SM-Signature`), delivered at-least-once with retries, SSRF-guarded and FLS-filtered. The bulk API arrives in P12, OAuth 2.0 + PKCE connected apps in P12, and a TypeScript SDK in P12.

## Consequences
+ One surface serves UI, integrators and AI tools.
− A generic API needs excellent describe/docs to be usable.

## Alternatives rejected
GraphQL first (deferred by decision); per-object bespoke endpoints (do not scale to custom objects).

> Changing this decision requires the owner's approval (§0.3) and a new superseding ADR.
