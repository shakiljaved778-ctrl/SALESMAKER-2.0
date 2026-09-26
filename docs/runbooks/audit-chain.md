# Audit chain: verify, and respond to a broken chain

Module: [audit](../modules/audit.md) · Spec §6.7 · ADR-0008

## When to use this

- Setup → Audit log says "Chain verification found a problem", or the worker logged `audit chain broken`.
- An auditor or a customer asks for proof that the audit log is intact.
- Setup shows entries "Being chained" for more than a few minutes (the chain is stuck).

## 1. Verify now

On a host with the cell's environment (worker image or a bastion with `.env`):

```bash
pnpm --filter @sm/worker build          # once, if dist/ is missing
pnpm --filter @sm/worker audit:verify <tenant-id>
# {"status":"OK","throughSeq":"1842","rows":"1842","pending":"0","problem":null}
```

It chains whatever is waiting, verifies every row and batch, records the result in `audit_verification` (Setup shows
it) and exits `0` when the chain is intact, `1` when it is not. The tenant id is in the control plane's tenant
directory, or on `/v1/me` for a signed-in admin.

## 2. The chain is stuck (entries stay "Being chained")

1. Is the worker running and connected as `sm_audit` (`CELL_AUDIT_DATABASE_URL`)? Its log shows `worker started`.
2. Is Valkey reachable? Chain runs take a lock `audit-chain:<tenant>` (60 s expiry). A lock left by a dead worker
   expires on its own; do not delete it by hand while a worker may hold it.
3. A missing sequence number holds the chain for up to five minutes, then is declared as a gap. Longer than that
   means the worker is not running the job: check the `maintenance` queue and its dead-letter queue.
4. Run step 1: the on-demand verify also chains.

## 3. The chain is broken

`problem` names the first failure: `row N does not match its hash`, `row N exists although it was declared a gap`,
`batch ending at N does not match its root`, `… is missing rows`, `… does not follow the previous root`, or
`N rows have waited too long to be chained` (a stuck chain, section 2, not tampering).

1. **Treat it as a security incident.** A broken chain means a row changed after it was chained, which only a
   superuser switching triggers off can do. Do not "repair" the chain: its value is that it cannot be rewritten.
2. Preserve evidence: snapshot the database, and export `audit_log`, `audit_batch` and `audit_verification` for the
   tenant (read-only role).
3. Compare the reported row with backups and point-in-time recovery to find what changed and when; check database
   audit logs for superuser sessions and `session_replication_role` changes.
4. Tell the customer's administrators per the incident process (ADR-0023), with the range affected.
5. New rows keep chaining after the broken point; later verifications keep reporting the same first problem, so the
   record of the incident stays visible.

## 4. Proving integrity to an auditor

Run step 1 and give them the JSON result, the `audit_verification` history for the period, and the batches'
Merkle roots (`audit_batch.merkle_root`, `prev_root`): any later change to a row changes its hash and every root
after it.
