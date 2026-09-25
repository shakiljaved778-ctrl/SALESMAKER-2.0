# ADR-0022: Per-tenant scale envelope: 1,000 users · 5M leads · 50M activities

- **Status:** Accepted (locked decision #8 in MASTER_SPEC §1.4)
- **Date:** 2026-09-25
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §11.1, §11.2, §15

## Context

Budgets and data design must be sized for the largest target tenant.

## Decision

Design and test for 1,000 users, 5M leads, 2M accounts, 3M contacts, 1M opportunities, 50M activities and 200M field-history rows per tenant. Keyset pagination everywhere. Monthly partitioning for activity, field_history and audit_log. Aggregates are computed in SQL. The Aurelia Bank seed (500k demo / 5M load) is the performance fixture, and k6 enforces the §11.1 budgets nightly.

## Consequences

- Avoids re-architecture at scale.
  − Heavy seed data and load environments cost CI and staging time.

## Alternatives rejected

Designing for SMB and scaling later (the sharing and query engines would not survive).

> Changing this decision requires the owner's approval (§0.3) and a new superseding ADR.
