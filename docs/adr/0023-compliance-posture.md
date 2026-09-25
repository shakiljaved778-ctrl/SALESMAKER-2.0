# ADR-0023: Compliance posture: SOC 2-ready, GDPR, Qatar PDPPL, UAE/KSA PDPL

- **Status:** Accepted (locked decision #32 in MASTER_SPEC §1.4)
- **Date:** 2026-09-25
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §6.6, §11.5, §11.6, §7.17

## Context

Target buyers (EU, GCC banks) require demonstrable controls.

## Decision

SOC 2-ready controls (branch protection, CodeQL, Dependabot, Trivy, gitleaks, SBOM, least-privilege IAM, Secrets Manager, access reviews, vulnerability SLAs, pen test). Encryption in transit and at rest with per-cell KMS, plus envelope encryption for secrets. Privacy by default (tracking off, AI PII redaction option, PII-free logs). DSAR, erasure and anonymisation tooling, a consent ledger and retention policies (P12). Breach runbook. A residency ADR addendum covers cross-border transfer notes per region.

## Consequences

- Enterprise-ready.
  − Legal inputs (regulator contacts, DPA, sub-processor list) must come from the owner.

## Alternatives rejected

Deferring compliance to post-launch (blocks the target market).

> Changing this decision requires the owner's approval (§0.3) and a new superseding ADR.
