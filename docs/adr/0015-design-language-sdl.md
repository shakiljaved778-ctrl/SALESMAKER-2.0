# ADR-0015: SalesMaker Design Language (SDL): reference, palette, themes, density

- **Status:** Accepted (locked decision #16, #17, #18, #23 in MASTER_SPEC §1.4)
- **Date:** 2026-09-25
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §9

## Context
The design reference is Salesforce Lightning density with Linear/Attio polish. The owner delegated palette choice to the architect, fixed as tokens. There is no tenant colour theming in v1.

## Decision
Implement §9 exactly in `@sm/ui`: Graphite neutrals, **Jade** brand, **Iris exclusively for AI**, status scales and an 8-slot categorical palette. Light/Dark/System themes via `data-theme`, with no flash of the wrong theme. Comfortable/Default/Compact density via `data-density`, with telesales profiles defaulting to Compact. Inter Variable plus JetBrains Mono. The spacing, radius, elevation, motion and z-index scales, and the component specs. Tenants may upload a logo only. A token contrast test gates CI. Any deviation needs an ADR and owner approval.

## Consequences
+ A coherent, dense, fast UI and a single source of design truth.
− Storybook coverage of variant × state × theme × density is substantial work.

## Alternatives rejected
Stock shadcn look (generic); tenant theming (deferred by decision).

> Changing this decision requires the owner's approval (§0.3) and a new superseding ADR.
