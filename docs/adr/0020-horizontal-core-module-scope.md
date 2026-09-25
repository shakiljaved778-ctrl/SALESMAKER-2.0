# ADR-0020: Horizontal configurable core and v1 module scope

- **Status:** Accepted (locked decision #5, #10 in MASTER_SPEC §1.4)
- **Date:** 2026-09-25
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §2, §5

## Context
The owner chose a horizontal product with configurable objects and fields, all §2.1 modules in v1, and Cases deferred to v2.

## Decision
No vertical objects or templates in v1: pipeline stage templates only, in onboarding. The metadata engine (custom fields, record types, layouts, validation, formulas; custom objects in P11) carries configurability. Scope is exactly §2.1. Service Cases are reserved for v2 and must not be built. §2.2 lists the explicit exclusions.

## Consequences
+ One product for many industries.
− Configurability pushes complexity into the metadata engine.

## Alternatives rejected
Vertical editions (fragmented codebase).

> Changing this decision requires the owner's approval (§0.3) and a new superseding ADR.
