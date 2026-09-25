# ADR-0025: Two seeded demo tenants

- **Status:** Accepted (locked decision #37 in MASTER_SPEC §1.4)
- **Date:** 2026-09-25
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §15

## Context

Sales demos and performance testing need realistic data.

## Decision

A deterministic faker seed in `packages/db/seed`: **Pixelcraft Studio** (5-rep agency, USD) and **Aurelia Bank Retail Sales** (800-rep floor, QAR + USD, Asia/Qatar; 500k leads demo / 5M load), run with `pnpm db:seed --scenario=agency|bank --scale=demo|load`. Demo users and a 'Reset demo' action exist on staging only. No real bank brands.

## Consequences

- One fixture serves demos and performance.
  − The load-scale seed takes significant time and storage to generate.

## Alternatives rejected

Hand-made fixtures (unrealistic).

> Changing this decision requires the owner's approval (§0.3) and a new superseding ADR.
