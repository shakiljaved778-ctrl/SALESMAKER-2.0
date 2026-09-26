# Audit

Spec: §6.7, §3.3 · ADR: 0008 (and its sequence-then-chain addendum in the P01 plan) · Code: `packages/db/src/audit.ts`,
`apps/worker/src/maintenance.ts`, `apps/api/src/audit`, `apps/web/src/components/setup/viewers` · Tables:
[ERD](../spec/ERD.md#governance-and-jobs-p01) · Runbook: [audit-chain](../runbooks/audit-chain.md)

Three append-only trails, each shown in Setup → Security:

| Trail                 | Holds                                                                                                             | Written by                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Audit log**         | Every record-level and security event (`user.invited`, `record.shared`, `user.password_changed`, …), hash-chained | `audit.record(tx, entry)`, in the audited transaction |
| **Setup audit trail** | Every configuration change, with the entity's before and after state                                              | `audit.setup(tx, entry)`, in the same transaction     |
| **Login history**     | Every sign-in attempt: method, outcome, user or email HMAC, session, IP, device                                   | the auth service                                      |

## The hash chain

1. `audit.record` inserts the row in the caller's transaction with the next number from the tenant's own sequence
   (`audit_next_seq()`), so audited writes never wait on each other. `sm_app` may insert and read audit rows, never
   update or delete them.
2. The insert emits `maintenance.audit_chain`. The worker, connected as `sm_audit` (the only role allowed to set a
   row's hash, exactly once), chains the tenant's new rows in order within about a second:
   `hash = SHA-256(prev_hash + "\n" + canonical JSON of the row)`, starting from 64 zeros. Each batch stores its head
   hash, a Merkle root over its rows and the previous batch's root.
3. A missing number stops the chain until a later row is five minutes old (longer than any transaction may run); it
   is then declared in the batch's `gaps`. A row that later appears inside a declared gap fails verification.
4. One chain run per tenant at a time, serialised by a Valkey lock plus a "dirty" mark, so no request is lost.

## Verification

Daily (03:17 UTC) the worker chains and verifies every tenant end to end — every row's hash, every batch's Merkle
root and link, and the gaps — and records the result in `audit_verification`. Setup → Audit log shows the last
result and how far chaining has reached. On demand: `pnpm --filter @sm/worker audit:verify <tenant-id>`. A broken
chain is logged at error level and shown in Setup with the first problem found.

## Rules for new code

- Audit inside the transaction that makes the change, never after it.
- Never put third-party secrets or tokens in a payload. P02 must mask fields the viewer cannot read (FLS, §6.5) in
  record-change payloads before record changes are audited.
- Viewing the trails needs `view_setup`.
