# ADR-0021: Full Salesforce-style territory management

- **Status:** Accepted (locked decision #9 in MASTER_SPEC §1.4)
- **Date:** 2026-09-25
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §7.3, §6.3, §7.12

## Context

Enterprise sales orgs plan by geography, industry and named accounts.

## Decision

In P10: multiple territory models (one active, others planning), typed hierarchies with a closure table, account/lead assignment rules, user roles (Owner/Member/Overlay), per-model access levels feeding `record_share` with reason `TERRITORY`, a run-assignment preview diff before activation, territory-based forecasting and reports. The `TERRITORY` assignment method becomes available at the same time.

## Consequences

- Enterprise-grade planning.
  − Large re-assignments generate heavy share recalculation, so they need batched jobs with progress.

## Alternatives rejected

Territories as simple tags (insufficient for access and forecasting).

> Changing this decision requires the owner's approval (§0.3) and a new superseding ADR.
