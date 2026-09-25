# ADR-0027: SalesMaker is fully separate from WealthEngine

- **Status:** Accepted (locked decision — (relationship row) in MASTER_SPEC §1.4)
- **Date:** 2026-09-25
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §1.4

## Context
The owner has other products (WealthEngine) in the same GitHub account.

## Decision
SalesMaker 2.0 shares no code, packages, infrastructure, databases, credentials or brand assets with WealthEngine. Nothing is copied or imported from other repositories.

## Consequences
+ Clean IP and security boundaries.
− No reuse shortcuts.

## Alternatives rejected
Sharing a component library or auth service (rejected by the owner).

> Changing this decision requires the owner's approval (§0.3) and a new superseding ADR.
