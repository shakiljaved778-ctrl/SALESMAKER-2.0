import type { CellPrisma } from './client.js';
import type { Prisma } from './generated/prisma/client.js';
import type { TenantTransaction } from './tenant.js';

/** BullMQ queues (§3.9). An outbox topic's prefix (before the first dot) names its queue. */
export const QUEUES = [
  'index',
  'sharing',
  'automation',
  'assignment',
  'import',
  'export',
  'email-sync',
  'messaging',
  'telephony',
  'ai',
  'webhooks-out',
  'reports',
  'pdf',
  'billing',
  'maintenance',
] as const;
export type QueueName = (typeof QUEUES)[number];

const TOPIC = /^([a-z][a-z0-9_-]*)\.[a-z][a-z0-9_.]*$/;

/** The queue an outbox topic routes to; throws for a malformed topic or an unknown queue. */
export function queueOf(topic: string): QueueName {
  const queue = TOPIC.exec(topic)?.[1];
  if (!queue || !(QUEUES as readonly string[]).includes(queue))
    throw new Error(`outbox topic "${topic}" does not name a known queue`);
  return queue as QueueName;
}

export interface OutboxMessage {
  /** `<queue>.<event>`, e.g. `sharing.owner_changed`. */
  topic: string;
  payload?: Prisma.InputJsonObject;
  aggregateType?: string;
  aggregateId?: string;
}

export interface OutboxEvent {
  id: string;
  tenantId: string;
  createdAt: Date;
  topic: string;
  aggregateType: string | null;
  aggregateId: string | null;
  payload: Prisma.JsonValue;
}

interface ClaimedRow {
  id: string;
  tenant_id: string;
  created_at: Date;
  topic: string;
  aggregate_type: string | null;
  aggregate_id: string | null;
  payload: Prisma.JsonValue;
}

/**
 * The transactional outbox (§3.7, §3.9). `emit` writes events in the caller's tenant
 * transaction, so they exist exactly when the change they announce commits. The worker's relay
 * `claim`s unpublished events (skipping rows another relay holds), enqueues them, and marks them
 * published before its transaction commits. Delivery is at least once; consumers dedupe by the
 * event id, which is also the BullMQ job id.
 */
export const outbox = {
  async emit(tx: TenantTransaction, messages: OutboxMessage | OutboxMessage[]): Promise<string[]> {
    const list = Array.isArray(messages) ? messages : [messages];
    if (list.length === 0) return [];
    for (const m of list) queueOf(m.topic);
    const rows = await tx.prisma.outboxEvent.createManyAndReturn({
      data: list.map((m) => ({
        tenantId: tx.context.tenantId,
        topic: m.topic,
        payload: m.payload ?? {},
        aggregateType: m.aggregateType ?? null,
        aggregateId: m.aggregateId ?? null,
      })),
      select: { id: true },
    });
    return rows.map((r) => r.id);
  },

  /** Lock and return up to `limit` of the tenant's oldest unpublished events. */
  async claim(tx: TenantTransaction, limit = 100): Promise<OutboxEvent[]> {
    const rows = await tx.prisma.$queryRaw<ClaimedRow[]>`
      SELECT id, tenant_id, created_at, topic, aggregate_type, aggregate_id, payload
      FROM outbox_event
      WHERE tenant_id = app_current_tenant_id() AND published_at IS NULL
      ORDER BY created_at, seq
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED`;
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      createdAt: r.created_at,
      topic: r.topic,
      aggregateType: r.aggregate_type,
      aggregateId: r.aggregate_id,
      payload: r.payload,
    }));
  },

  async markPublished(tx: TenantTransaction, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await tx.prisma.outboxEvent.updateMany({
      where: { id: { in: [...ids] }, publishedAt: null },
      data: { publishedAt: new Date() },
    });
  },

  /**
   * Create upcoming daily partitions and drop expired ones (7-day retention by default). Touches
   * no tenant rows, so it runs outside a tenant transaction.
   */
  async maintainPartitions(
    prisma: CellPrisma,
    options: { daysAhead?: number; retentionDays?: number } = {},
  ): Promise<{ created: string[]; dropped: string[] }> {
    const [result] = await prisma.$queryRaw<{ created: string[]; dropped: string[] }[]>`
      SELECT created, dropped
      FROM outbox_maintain_partitions(${options.daysAhead ?? 7}::int, ${options.retentionDays ?? 7}::int)`;
    return { created: result?.created ?? [], dropped: result?.dropped ?? [] };
  },
};
