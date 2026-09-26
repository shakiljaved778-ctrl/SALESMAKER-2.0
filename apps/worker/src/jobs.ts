import type { CellPrisma, QueueName } from '@sm/db';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';

/**
 * What every job carries (§3.9). Jobs from the outbox belong to a tenant; cell-wide system jobs
 * (such as partition maintenance) have `tenantId: null` and never touch tenant rows.
 */
export interface JobEnvelope {
  /** The outbox event id, which is also the BullMQ job id: consumers dedupe on it. */
  eventId: string;
  tenantId: string | null;
  topic: string;
  aggregateType: string | null;
  aggregateId: string | null;
  payload: unknown;
  /** ISO time the event was written. */
  createdAt: string;
}

export interface HandlerContext {
  prisma: CellPrisma;
  logger: Logger;
  job: Job<JobEnvelope>;
}

export type JobHandler = (envelope: JobEnvelope, context: HandlerContext) => Promise<void>;

/** Consumers by queue. A queue without a handler still receives jobs; they wait for one. */
export type Handlers = Partial<Record<QueueName, JobHandler>>;

export const DEAD_LETTER_QUEUE = 'dead-letter';
