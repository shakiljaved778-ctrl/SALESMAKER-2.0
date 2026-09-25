# ADR-0007: Salesforce-style permission and sharing model

- **Status:** Accepted (locked decision #31 (and #7) in MASTER_SPEC §1.4)
- **Date:** 2026-09-25
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §6.2–§6.5

## Context

Buyers range from 5-rep agencies to 800-rep bank floors with deep hierarchies and strict need-to-know.

## Decision

Authorisation layers are evaluated in order: tenant (RLS) → system permissions → object permissions → record access → FLS. Profiles plus **additive** permission sets and groups (with an optional single muting set). The org hierarchy is an unlimited-depth `org_unit` tree with a closure table (#7). Record sharing uses OWDs, hierarchy access, owner- and criteria-based sharing rules, queues, teams, manual shares and (P10) territories. Sharing is computed via a materialised `user_visibility_closure` plus a `record_share` table partitioned by object, and cached principal sets. The Query Engine injects the sharing predicate. FLS is enforced at every point listed in §6.5.

## Consequences

- Familiar to CRM admins, and expressive enough for bank-style floors.
  − The most performance-critical subsystem: it needs the 800-rep fixture and p95 budgets from P01 onward.
  − Async rule convergence (< 60 s p95) must be communicated in the UI.

## Alternatives rejected

Simple RBAC (insufficient for enterprise); per-user sharing inside RLS (too slow at 5M rows); ABAC policy engine (hard for admins to reason about).

> Changing this decision requires the owner's approval (§0.3) and a new superseding ADR.
