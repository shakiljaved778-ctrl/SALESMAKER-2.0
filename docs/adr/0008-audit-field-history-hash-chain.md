# ADR-0008: Field history plus an immutable, hash-chained audit log

- **Status:** Accepted (locked decision #33 in MASTER_SPEC §1.4)
- **Date:** 2026-09-25
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §3.7, §4.2, §6.7

## Context

SOC 2 readiness and regulated buyers need tamper-evident audit and per-field history.

## Decision

RecordService writes `field_history` rows for tracked fields (≤ 60 per object; 24-month default retention, up to 10 years on higher plans) and an `audit_log` entry **in the same transaction**. `audit_log` is append-only (no UPDATE/DELETE grants for `sm_app`) and partitioned monthly. Each row stores `prev_hash` and `hash = H(prev_hash ‖ canonical(row))` in a **per-tenant chain**. A verifier job re-walks the chain. Setup changes go to `setup_audit`, and support reads are audited to the tenant. The P01 plan will detail how appends are serialised without a global hotspot (per-tenant advisory lock or a sequence-then-chain batcher).

## Consequences

- Tamper evidence, and a clear 'who/what/why' trail for automation and AI actors.
  − A per-tenant chain serialises audit appends: this needs a design that keeps write p95 ≤ 250 ms under bulk load.

## Alternatives rejected

Plain audit table (not tamper-evident); external ledger service (cost, and residency).

> Changing this decision requires the owner's approval (§0.3) and a new superseding ADR.

## Addendum (2026-09-25, P01 plan approval, Q15)

Appends are serialised with the **sequence-then-chain batcher**, not a per-tenant lock. Each audited transaction
inserts its `audit_log` row with a per-tenant sequence number and no hash. A per-tenant chaining job (serialised by a
BullMQ group key) hashes committed rows in sequence order, `hash = SHA-256(prev_hash ‖ canonical(row))`, and records
an `audit_batch` row with the batch's Merkle root and the previous root. Only the `sm_audit` role may set a row's hash,
once. Rolled-back sequence numbers are recorded as explicit gaps. The verifier re-walks rows and batch roots. Details:
`docs/phases/P01-plan.md` §3.3.
