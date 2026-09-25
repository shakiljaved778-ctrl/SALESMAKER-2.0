# ADR-0018: English-only v1 with an RTL-ready architecture

- **Status:** Accepted (locked decision #19 in MASTER_SPEC §1.4)
- **Date:** 2026-09-25
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §9.12

## Context
Arabic is a strategic future locale. v1 ships English.

## Decision
All copy goes through `next-intl` keys with ICU. Tailwind logical utilities only, with physical-direction classes banned by lint. `dir` is set from the locale. An RTL pseudo-locale is tested in Storybook plus a Playwright smoke suite from P00, alongside the `en-XA` pseudo-locale. Directional icons carry `data-mirror`. Time-series chart axes stay LTR in RTL. IBM Plex Sans Arabic is declared but not loaded, and line height gets +10% for `[lang=ar]`.

## Consequences
+ Arabic becomes a translation and QA exercise, not a refactor.
− Lint friction for contributors used to `ml-`/`mr-`.

## Alternatives rejected
Retrofitting RTL later (costly refactor).

> Changing this decision requires the owner's approval (§0.3) and a new superseding ADR.
