import { QUEUES, type QueueName } from '@sm/db';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import { DEAD_LETTER_QUEUE, type JobEnvelope } from './jobs.js';

export interface QueueSet {
  get(name: QueueName): Queue<JobEnvelope>;
  deadLetter: Queue<DeadLetter>;
  close(): Promise<void>;
}

export interface DeadLetter {
  queue: string;
  jobId: string;
  envelope: JobEnvelope;
  failedReason: string;
  attemptsMade: number;
  failedAt: string;
}

/** One producer per §3.9 queue, plus the dead-letter queue, all under one key prefix. */
export function createQueues(
  connection: Redis,
  prefix: string,
  job: { attempts: number; backoffMs: number },
): QueueSet {
  const queues = new Map<QueueName, Queue<JobEnvelope>>(
    QUEUES.map((name) => [
      name,
      new Queue<JobEnvelope>(name, {
        connection,
        prefix,
        defaultJobOptions: {
          attempts: job.attempts,
          backoff: { type: 'exponential', delay: job.backoffMs },
          removeOnComplete: { age: 3600, count: 10_000 },
          // Failed jobs are copied to the dead-letter queue, so the originals need not linger.
          removeOnFail: { age: 7 * 86_400 },
        },
      }),
    ]),
  );
  const deadLetter = new Queue<DeadLetter>(DEAD_LETTER_QUEUE, {
    connection,
    prefix,
    defaultJobOptions: { removeOnComplete: false, removeOnFail: false },
  });
  return {
    get(name) {
      const queue = queues.get(name);
      if (!queue) throw new Error(`unknown queue ${name}`);
      return queue;
    },
    deadLetter,
    async close() {
      await Promise.all([...queues.values(), deadLetter].map((q) => q.close()));
    },
  };
}
