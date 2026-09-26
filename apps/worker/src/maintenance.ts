import { outbox } from '@sm/db';

import type { JobHandler } from './jobs.js';
import type { QueueSet } from './queues.js';

export const OUTBOX_PARTITIONS_TOPIC = 'maintenance.outbox_partitions';

/** Cell-wide housekeeping on the `maintenance` queue. Touches no tenant rows. */
export const maintenanceHandler: JobHandler = async (envelope, { prisma, logger }) => {
  if (envelope.topic === OUTBOX_PARTITIONS_TOPIC) {
    const result = await outbox.maintainPartitions(prisma);
    if (result.created.length || result.dropped.length)
      logger.info(result, 'outbox partitions maintained');
    return;
  }
  throw new Error(`unknown maintenance job ${envelope.topic}`);
};

/** Schedule the recurring maintenance jobs (idempotent: safe from every worker replica). */
export async function scheduleMaintenance(queues: QueueSet): Promise<void> {
  await queues.get('maintenance').upsertJobScheduler(
    OUTBOX_PARTITIONS_TOPIC,
    { every: 3_600_000, immediately: true },
    {
      name: OUTBOX_PARTITIONS_TOPIC,
      data: {
        eventId: OUTBOX_PARTITIONS_TOPIC,
        tenantId: null,
        topic: OUTBOX_PARTITIONS_TOPIC,
        aggregateType: null,
        aggregateId: null,
        payload: {},
        createdAt: new Date(0).toISOString(),
      },
    },
  );
}
