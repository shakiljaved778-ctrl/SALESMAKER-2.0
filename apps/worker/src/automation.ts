import type { JobHandler } from './jobs.js';

/** Record events RecordService emits (§3.7 step 8). */
export const RECORD_EVENTS = new Set([
  'automation.record_created',
  'automation.record_updated',
  'automation.record_deleted',
  'automation.record_restored',
  'automation.owner_changed',
  'automation.stage_changed',
]);

/**
 * The `automation` queue (§3.9). Flows, webhooks and AI signals subscribe to record events from
 * P07/P08; until then the consumer acknowledges them so the queue never backs up.
 */
export const automationHandler: JobHandler = (envelope) =>
  RECORD_EVENTS.has(envelope.topic)
    ? Promise.resolve()
    : Promise.reject(new Error(`unknown automation job ${envelope.topic}`));
