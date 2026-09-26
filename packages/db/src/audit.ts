import { createHash } from 'node:crypto';

import type { Prisma } from './generated/prisma/client.js';
import { outbox } from './outbox.js';
import type { TenantTransaction } from './tenant.js';

export type ActorType = 'user' | 'system' | 'agent' | 'support';

export interface AuditEntry {
  action: string;
  object?: string;
  recordId?: string;
  payload?: Prisma.InputJsonObject;
  /** Defaults to the transaction's user (actorType `user`), or `system` when there is none. */
  actorType?: ActorType;
  actorId?: string;
  onBehalfOf?: string;
  requestId?: string;
}

export interface SetupAuditEntry {
  action: string;
  entityType: string;
  entityId?: string;
  entityName?: string;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
  actorId?: string;
  requestId?: string;
}

/** The outbox topic that asks the worker to chain a tenant's new audit rows. */
export const AUDIT_CHAIN_TOPIC = 'maintenance.audit_chain';

/** The hash before the first row of every tenant's chain. */
export const GENESIS = '0'.repeat(64);

/**
 * How old a committed row after a missing sequence number must be before that number is declared
 * a gap (its transaction rolled back): far longer than any transaction may run (§3.8: 120 s).
 */
export const GAP_GRACE_MS = 5 * 60_000;

/** JSON with object keys sorted at every level: one byte-exact form per value. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** The fields of an audit row that its hash covers. Timestamps keep full microsecond precision. */
export interface ChainedFields {
  tenantId: string;
  id: string;
  seq: string;
  occurredAt: string;
  actorType: string;
  actorId: string | null;
  onBehalfOf: string | null;
  action: string;
  object: string | null;
  recordId: string | null;
  payload: unknown;
  requestId: string | null;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** `hash = SHA-256(prev_hash ‖ canonical(row))` (ADR-0008). */
export function chainHash(prevHash: string, row: ChainedFields): string {
  return sha256(`${prevHash}\n${canonicalJson(row)}`);
}

/** Merkle root of a batch's row hashes (pairwise SHA-256; an odd node pairs with itself). */
export function merkleRoot(hashes: readonly string[]): string {
  if (hashes.length === 0) throw new Error('merkleRoot needs at least one hash');
  let level = [...hashes];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i] ?? '';
      next.push(sha256(left + (level[i + 1] ?? left)));
    }
    level = next;
  }
  return level[0] ?? '';
}

interface RawRow {
  tenant_id: string;
  id: string;
  seq: bigint;
  occurred_at: string;
  inserted_at: Date;
  actor_type: string;
  actor_id: string | null;
  on_behalf_of: string | null;
  action: string;
  object: string | null;
  record_id: string | null;
  payload: unknown;
  request_id: string | null;
  prev_hash: string | null;
  hash: string | null;
}

const ROW_COLUMNS = `tenant_id, id, seq,
  to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,
  inserted_at, actor_type, actor_id, on_behalf_of, action, object, record_id, payload,
  request_id, prev_hash, hash`;

function fields(r: RawRow): ChainedFields {
  return {
    tenantId: r.tenant_id,
    id: r.id,
    seq: r.seq.toString(),
    occurredAt: r.occurred_at,
    actorType: r.actor_type,
    actorId: r.actor_id,
    onBehalfOf: r.on_behalf_of,
    action: r.action,
    object: r.object,
    recordId: r.record_id,
    payload: r.payload,
    requestId: r.request_id,
  };
}

export interface ChainResult {
  rows: number;
  batches: number;
  gaps: bigint[];
  headSeq: bigint | null;
}

export interface VerificationResult {
  ok: boolean;
  throughSeq: bigint | null;
  batches: number;
  rows: number;
  pending: number;
  problem: string | null;
}

export const audit = {
  /**
   * Append an audit entry in the caller's transaction (golden rule: in the same transaction as
   * the change). It gets the tenant's next sequence number; the worker chains it after commit.
   */
  async record(tx: TenantTransaction, entry: AuditEntry): Promise<string> {
    const { tenantId, userId } = tx.context;
    const actorId = entry.actorId ?? userId ?? null;
    const row = await tx.prisma.auditLog.create({
      data: {
        tenantId,
        actorType: entry.actorType ?? (actorId ? 'user' : 'system'),
        actorId,
        onBehalfOf: entry.onBehalfOf ?? null,
        action: entry.action,
        object: entry.object ?? null,
        recordId: entry.recordId ?? null,
        payload: entry.payload ?? {},
        requestId: entry.requestId ?? null,
      },
      select: { id: true },
    });
    await outbox.emit(tx, { topic: AUDIT_CHAIN_TOPIC });
    return row.id;
  },

  /** Record a Setup change with its before and after state (§5.6). */
  async setup(tx: TenantTransaction, entry: SetupAuditEntry): Promise<void> {
    const { tenantId, userId } = tx.context;
    await tx.prisma.setupAudit.create({
      data: {
        tenantId,
        actorId: entry.actorId ?? userId ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        entityName: entry.entityName ?? null,
        ...(entry.before === undefined || entry.before === null ? {} : { before: entry.before }),
        ...(entry.after === undefined || entry.after === null ? {} : { after: entry.after }),
        requestId: entry.requestId ?? null,
      },
    });
  },

  /**
   * Chain the tenant's committed, unchained rows in sequence order (ADR-0008 addendum). Must run
   * as sm_audit, one run per tenant at a time. Stops at a missing sequence number that may still
   * commit; declares it a gap once a later row is older than `graceMs`. Each batch commits on its
   * own, so a crash loses nothing.
   */
  async chain(
    inTransaction: <T>(fn: (tx: TenantTransaction) => Promise<T>) => Promise<T>,
    options: { batchSize?: number; graceMs?: number; now?: () => Date } = {},
  ): Promise<ChainResult> {
    const { batchSize = 500, graceMs = GAP_GRACE_MS, now = () => new Date() } = options;
    const result: ChainResult = { rows: 0, batches: 0, gaps: [], headSeq: null };
    for (;;) {
      const step = await inTransaction(async (tx) => {
        const head = await tx.prisma.auditBatch.findFirst({ orderBy: { lastSeq: 'desc' } });
        const nextSeq = head ? head.lastSeq + 1n : 1n;
        const rows = await tx.prisma.$queryRawUnsafe<RawRow[]>(
          `SELECT ${ROW_COLUMNS} FROM audit_log
           WHERE tenant_id = app_current_tenant_id() AND seq >= $1 AND hash IS NULL
           ORDER BY seq LIMIT $2`,
          nextSeq,
          batchSize,
        );
        const take: RawRow[] = [];
        const gaps: bigint[] = [];
        let expected = nextSeq;
        for (const row of rows) {
          if (row.seq > expected) {
            // Numbers expected..seq-1 are missing: in flight, or rolled back long ago.
            if (now().getTime() - row.inserted_at.getTime() < graceMs) break;
            for (let s = expected; s < row.seq; s += 1n) gaps.push(s);
          }
          take.push(row);
          expected = row.seq + 1n;
        }
        if (take.length === 0) return null;
        let prev = head?.headHash ?? GENESIS;
        const hashes: string[] = [];
        for (const row of take) {
          const hash = chainHash(prev, fields(row));
          await tx.prisma.$executeRaw`
            UPDATE audit_log SET prev_hash = ${prev}, hash = ${hash}, chained_at = now()
            WHERE tenant_id = app_current_tenant_id() AND id = ${row.id}::uuid
              AND occurred_at = ${row.occurred_at}::timestamptz`;
          hashes.push(hash);
          prev = hash;
        }
        const last = take.at(-1)?.seq ?? nextSeq;
        await tx.prisma.auditBatch.create({
          data: {
            tenantId: tx.context.tenantId,
            firstSeq: nextSeq,
            lastSeq: last,
            rowCount: take.length,
            gaps,
            headHash: prev,
            merkleRoot: merkleRoot(hashes),
            prevRoot: head?.merkleRoot ?? null,
          },
        });
        return {
          rows: take.length,
          gaps,
          last,
          more: rows.length === batchSize && take.length === rows.length,
        };
      });
      if (!step) return result;
      result.rows += step.rows;
      result.batches += 1;
      result.gaps.push(...step.gaps);
      result.headSeq = step.last;
      if (!step.more) return result;
    }
  },

  /**
   * Re-walk the whole chain (ADR-0008): every batch links to the previous root, every row's hash
   * recomputes from its predecessor, every batch's Merkle root and head match its rows, declared
   * gaps have no row, and no row older than `graceMs` is left unchained. Read-only.
   */
  async verify(
    tx: TenantTransaction,
    options: { graceMs?: number; now?: () => Date } = {},
  ): Promise<VerificationResult> {
    const { graceMs = GAP_GRACE_MS, now = () => new Date() } = options;
    const batches = await tx.prisma.auditBatch.findMany({ orderBy: { lastSeq: 'asc' } });
    let prevHash = GENESIS;
    let prevRoot: string | null = null;
    let prevLast = 0n;
    let rows = 0;
    const fail = (problem: string): VerificationResult => ({
      ok: false,
      throughSeq: prevLast || null,
      batches: batches.length,
      rows,
      pending: 0,
      problem,
    });
    for (const batch of batches) {
      if (batch.prevRoot !== prevRoot)
        return fail(
          `batch ending at ${batch.lastSeq.toString()} does not follow the previous root`,
        );
      if (batch.firstSeq !== prevLast + 1n)
        return fail(
          `batch ending at ${batch.lastSeq.toString()} does not start after the previous one`,
        );
      const inBatch = await tx.prisma.$queryRawUnsafe<RawRow[]>(
        `SELECT ${ROW_COLUMNS} FROM audit_log
         WHERE tenant_id = app_current_tenant_id() AND seq BETWEEN $1 AND $2 ORDER BY seq`,
        batch.firstSeq,
        batch.lastSeq,
      );
      const gaps = new Set(batch.gaps.map((g) => g.toString()));
      const hashes: string[] = [];
      for (const row of inBatch) {
        if (gaps.has(row.seq.toString()))
          return fail(`row ${row.seq.toString()} exists although it was declared a gap`);
        const expected = chainHash(prevHash, fields(row));
        if (row.prev_hash !== prevHash || row.hash !== expected)
          return fail(`row ${row.seq.toString()} does not match its hash`);
        hashes.push(expected);
        prevHash = expected;
      }
      const expectedCount = Number(batch.lastSeq - batch.firstSeq + 1n) - gaps.size;
      if (inBatch.length !== expectedCount || inBatch.length !== batch.rowCount)
        return fail(`batch ending at ${batch.lastSeq.toString()} is missing rows`);
      if (merkleRoot(hashes) !== batch.merkleRoot || batch.headHash !== prevHash)
        return fail(`batch ending at ${batch.lastSeq.toString()} does not match its root`);
      rows += inBatch.length;
      prevRoot = batch.merkleRoot;
      prevLast = batch.lastSeq;
    }
    const [unchained] = await tx.prisma.$queryRaw<{ pending: bigint; stale: bigint }[]>`
      SELECT count(*) AS pending,
             count(*) FILTER (WHERE inserted_at < ${new Date(now().getTime() - graceMs)}) AS stale
      FROM audit_log WHERE tenant_id = app_current_tenant_id() AND hash IS NULL`;
    const pending = Number(unchained?.pending ?? 0n);
    if ((unchained?.stale ?? 0n) > 0n)
      return {
        ...fail(`${String(unchained?.stale)} rows have waited too long to be chained`),
        pending,
      };
    return {
      ok: true,
      throughSeq: prevLast || null,
      batches: batches.length,
      rows,
      pending,
      problem: null,
    };
  },

  /** Create upcoming monthly partitions (touches no tenant rows). */
  async maintainPartitions(prisma: {
    $queryRaw: TenantTransaction['prisma']['$queryRaw'];
  }): Promise<string[]> {
    const [row] = await prisma.$queryRaw<
      { made: string[] }[]
    >`SELECT audit_maintain_partitions() AS made`;
    return row?.made ?? [];
  },
};
