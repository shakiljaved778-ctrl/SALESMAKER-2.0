# ADR-0024: Engineering process: phased delivery, ADRs, test-first, one PR per feature

- **Status:** Accepted (locked decision #29, #35, #36 in MASTER_SPEC §1.4)
- **Date:** 2026-09-25
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §0.2, §13

## Context

An AI-driven build needs strong guardrails and traceability.

## Decision

The master spec plus phase prompts P00–P12. Each phase follows plan → approval → tasks → handoff. CLAUDE.md, MADR ADRs, Conventional Commits, `feat/Pxx-<slug>` branches, one PR per feature task (≤ ~600 lines), test-first for logic, coverage gates, `pnpm verify` as the local gate, and GitHub Actions CI (lint, typecheck, unit, integration with Testcontainers, rls-audit, Playwright e2e + axe + visual, OpenAPI drift, security scans). The 'repo scaffold supplied' in #36 was not included in the pack, so P00 derives the scaffold from §3.3.

## Consequences

- Reviewable increments with a paper trail.
  − Process overhead per change, which is accepted.

## Alternatives rejected

Big-bang build (unreviewable).

> Changing this decision requires the owner's approval (§0.3) and a new superseding ADR.
