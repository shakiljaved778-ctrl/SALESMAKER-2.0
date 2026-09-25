# ADR-0028: Name and code namespace

- **Status:** Accepted (locked decision #1 in MASTER_SPEC §1.4)
- **Date:** 2026-09-25
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §1.4

## Context

Consistent naming across packages, domains, keys and events.

## Decision

The product is **SalesMaker 2.0**. Code namespace `salesmaker`, package scope `@sm/*` (public SDK `@salesmaker/sdk`), domains under `salesmaker.app` (`{slug}.salesmaker.app`, `{region}.api.salesmaker.app`, `forms.`, `developers.`, `status.`), API key prefixes `sm_live_`/`sm_test_`, webhook header `SM-Signature`, DB roles `sm_*`.

## Consequences

- Predictable identifiers.
  − Domain ownership must be confirmed by the owner.

## Alternatives rejected

—

> Changing this decision requires the owner's approval (§0.3) and a new superseding ADR.
