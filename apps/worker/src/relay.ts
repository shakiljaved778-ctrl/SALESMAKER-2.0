import { outbox, queueOf, withTenant, type CellPrisma, type OutboxEvent } from '@sm/db';
import type { ControlPlane } from '@sm/server-kit';
import pg from 'pg';
import type { Logger } from 'pino';

import type { FairScheduler } from './fairness.js';
import type { JobEnvelope } from './jobs.js';
import type { QueueSet } from './queues.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RelayOptions {
  prisma: CellPrisma;
  queues: QueueSet;
  fairness: FairScheduler;
  controlPlane: Pick<ControlPlane, 'listCellTenants'>;
  logger: Logger;
  batch: number;
  /** Direct connection string for LISTEN. */
  listenUrl: string;
  sweepSeconds: number;
}

function envelopeOf(event: OutboxEvent): JobEnvelope {
  return {
    eventId: event.id,
    tenantId: event.tenantId,
    topic: event.topic,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    payload: event.payload,
    createdAt: event.createdAt.toISOString(),
  };
}

/**
 * The outbox relay (§3.7, §3.9). A commit that writes outbox events NOTIFYs `sm_outbox` with its
 * tenant id; the relay then drains that tenant inside a normal tenant transaction (RLS applies,
 * no cross-tenant read ever happens): claim a batch with SKIP LOCKED, enqueue each event with
 * its id as the job id and a fair per-tenant priority, mark the batch published, commit.
 * A periodic sweep over the cell's tenants (from the control plane) picks up anything a missed
 * notification left behind, e.g. while the worker was down. Delivery is at least once.
 */
export class OutboxRelay {
  private listener: pg.Client | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;
  private readonly draining = new Map<string, Promise<number>>();
  private readonly dirty = new Set<string>();
  private stopped = false;

  constructor(private readonly options: RelayOptions) {}

  /** Publish all of a tenant's pending events. Concurrent calls for one tenant coalesce. */
  drain(tenantId: string): Promise<number> {
    const running = this.draining.get(tenantId);
    if (running) {
      this.dirty.add(tenantId);
      return running;
    }
    const run = this.drainLoop(tenantId).finally(() => {
      this.draining.delete(tenantId);
    });
    this.draining.set(tenantId, run);
    return run;
  }

  private async drainLoop(tenantId: string): Promise<number> {
    let total = 0;
    for (;;) {
      this.dirty.delete(tenantId);
      const published = await this.publishBatch(tenantId);
      total += published;
      if (published < this.options.batch && !this.dirty.has(tenantId)) return total;
    }
  }

  private publishBatch(tenantId: string): Promise<number> {
    const { prisma, queues, fairness, batch } = this.options;
    return withTenant(
      prisma,
      { tenantId },
      async (tx) => {
        const events = await outbox.claim(tx, batch);
        for (const event of events) {
          const queue = queues.get(queueOf(event.topic));
          // A replayed event (enqueued before, but that commit was lost) already has its job:
          // skip it rather than take a second fairness slot. The row lock makes this race-free.
          if (await queue.getJob(event.id)) continue;
          const priority = await fairness.admit(queue.name, tenantId);
          await queue.add(event.topic, envelopeOf(event), { jobId: event.id, priority });
        }
        await outbox.markPublished(
          tx,
          events.map((e) => e.id),
        );
        return events.length;
      },
      { statementTimeoutMs: 30_000, timeoutMs: 60_000 },
    );
  }

  /** Drain every tenant this cell hosts, a page at a time. Returns the events published. */
  async sweep(): Promise<number> {
    let total = 0;
    let after: string | undefined;
    do {
      const page = await this.options.controlPlane.listCellTenants(after ? { after } : {});
      for (const tenantId of page.tenantIds) {
        if (this.stopped) return total;
        total += await this.drain(tenantId);
      }
      after = page.next ?? undefined;
    } while (after);
    return total;
  }

  /** Listen for commits, sweep once for anything pending, then sweep on a timer. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.listen();
    await this.safeSweep();
    this.sweepTimer = setInterval(() => {
      void this.safeSweep();
    }, this.options.sweepSeconds * 1000);
    this.sweepTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.sweepTimer);
    const listener = this.listener;
    this.listener = undefined;
    await listener?.end().catch(() => undefined);
    await Promise.allSettled(this.draining.values());
  }

  private async safeSweep(): Promise<void> {
    try {
      const published = await this.sweep();
      if (published) this.options.logger.info({ published }, 'outbox sweep published events');
    } catch (err) {
      this.options.logger.error({ err }, 'outbox sweep failed; retrying at the next interval');
    }
  }

  private async listen(): Promise<void> {
    const client = new pg.Client({ connectionString: this.options.listenUrl });
    client.on('notification', (message) => {
      const tenantId = message.payload ?? '';
      if (message.channel !== 'sm_outbox' || !UUID.test(tenantId)) return;
      this.drain(tenantId).catch((err: unknown) => {
        this.options.logger.error({ err, tenantId }, 'outbox drain failed; the sweep will retry');
      });
    });
    client.on('error', (err) => {
      this.options.logger.warn({ err }, 'outbox listener lost its connection; reconnecting');
      if (this.listener === client) this.listener = undefined;
      void client.end().catch(() => undefined);
      if (!this.stopped)
        setTimeout(() => {
          if (!this.stopped) void this.listen().then(() => this.safeSweep());
        }, 1000).unref();
    });
    await client.connect();
    await client.query('LISTEN sm_outbox');
    this.listener = client;
  }
}
