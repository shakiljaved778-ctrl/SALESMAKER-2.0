import type { CellPrisma } from '@sm/db';
import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import type { FairScheduler } from './fairness.js';
import type { Handlers, JobEnvelope } from './jobs.js';
import type { QueueSet } from './queues.js';

export interface ConsumerOptions {
  connection: Redis;
  prefix: string;
  concurrency: number;
  prisma: CellPrisma;
  queues: QueueSet;
  fairness: FairScheduler;
  logger: Logger;
}

/**
 * One BullMQ worker per queue that has a handler. A job that succeeds, or fails its last attempt,
 * frees its tenant's fairness slot; a final failure is copied to the dead-letter queue with its
 * reason so it can be inspected and replayed (§3.9).
 */
export function startConsumers(handlers: Handlers, options: ConsumerOptions): Worker[] {
  const { connection, prefix, concurrency, prisma, queues, fairness, logger } = options;
  return Object.entries(handlers).map(([queue, handler]) => {
    const worker = new Worker<JobEnvelope>(
      queue,
      async (job) => {
        const log = logger.child({ queue, jobId: job.id, tenantId: job.data.tenantId });
        await handler(job.data, { prisma, logger: log, job });
      },
      { connection, prefix, concurrency },
    );
    const release = async (job: Job<JobEnvelope>) => {
      if (job.data.tenantId) await fairness.release(queue, job.data.tenantId);
    };
    worker.on('completed', (job) => {
      void release(job).catch((err: unknown) => {
        logger.warn({ err, queue, jobId: job.id }, 'could not release a fairness slot');
      });
    });
    worker.on('failed', (job, err) => {
      if (!job) return;
      const attempts = job.opts.attempts ?? 1;
      if (job.attemptsMade < attempts) {
        logger.warn(
          { err, queue, jobId: job.id, attempt: job.attemptsMade },
          'job failed; retrying',
        );
        return;
      }
      logger.error({ err, queue, jobId: job.id }, 'job failed its last attempt; dead-lettered');
      void Promise.all([
        queues.deadLetter.add(
          `${queue}:${job.data.topic}`,
          {
            queue,
            jobId: String(job.id),
            envelope: job.data,
            failedReason: err.message,
            attemptsMade: job.attemptsMade,
            failedAt: new Date().toISOString(),
          },
          { jobId: `${queue}.${String(job.id)}` },
        ),
        release(job),
      ]).catch((dlqError: unknown) => {
        logger.error({ err: dlqError, queue, jobId: job.id }, 'could not dead-letter a job');
      });
    });
    worker.on('error', (err) => {
      logger.error({ err, queue }, 'worker error');
    });
    return worker;
  });
}
