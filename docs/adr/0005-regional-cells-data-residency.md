# ADR-0005: Regional cells and per-tenant data residency

- **Status:** Accepted (locked decision #26 (and #2) in MASTER_SPEC §1.4)
- **Date:** 2026-09-25
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §3.4, §11.6

## Context

The customers are global, including GCC and EU, and are subject to GDPR, Qatar PDPPL, and UAE/KSA PDPL. Tenants choose a data region at signup.

## Decision

Each region is a **cell**: a complete stack (API, workers, realtime, Postgres, Redis, S3, search). Tenant data never leaves its cell, except aggregated, non-personal usage/billing counters. The global control plane (`apps/control-api`) holds the tenant directory, login routing, Stripe and entitlements, and **no CRM data**. The cell URL is always resolved from the tenant directory and never hard-coded. There are no cross-cell joins. Launch regions: us-east-1, eu-central-1, me-central-1, ap-south-1. The MVP runs eu-central-1 only, and P12 adds me-central-1. Enterprise tenants can later get a dedicated cell.

## Consequences

- A credible residency story for GCC/EU buyers.
  − Every sub-processor (AI, telephony, email, speech) needs a per-region endpoint or a documented cross-border transfer.
  − Operating N cells multiplies infra cost and deploy complexity (canary cell first).

## Alternatives rejected

Single global region (fails residency); per-tenant databases in regions (ops cost).

> Changing this decision requires the owner's approval (§0.3) and a new superseding ADR.
