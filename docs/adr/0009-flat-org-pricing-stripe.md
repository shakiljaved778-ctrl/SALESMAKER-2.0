# ADR-0009: Flat per-organisation pricing on Stripe

- **Status:** Accepted (locked decision #4, #30 (and #3) in MASTER_SPEC §1.4)
- **Date:** 2026-09-25
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §12

## Context

The owner chose flat org pricing over per-seat pricing, and self-serve subscription billing.

## Decision

Plans are flat monthly or annual fees per org, differentiated by features and **limits** (user hard cap, storage, AI credits, API calls/day, custom objects). Prices live only in Stripe. `cp_plan` syncs from Stripe Products/Prices metadata, and the code never hard-codes prices. Stripe Checkout, Customer Portal and Tax are used. Webhooks are processed idempotently in the control plane (`cp_stripe_event` unique on the event id) and entitlements are pushed to the cell. Guards and UI use one helper, `can(tenant, feature)` / `limit(tenant, key)`. Downgrades are blocked above the target plan's limits.

## Consequences

- Simple buying story.
  − The per-plan user caps are what keep flat pricing viable (owner to confirm before P05).
  − The trial plan must be settled (see the open questions).

## Alternatives rejected

Per-seat pricing (rejected by the owner); usage-only pricing (unpredictable for buyers).

> Changing this decision requires the owner's approval (§0.3) and a new superseding ADR.
