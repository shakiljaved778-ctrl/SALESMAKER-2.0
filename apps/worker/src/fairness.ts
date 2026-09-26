import type { Redis } from 'ioredis';

/** BullMQ's largest priority; bigger numbers run later. */
export const MAX_PRIORITY = 2_097_151;

// Decrement without going below zero, and drop the key when it empties.
const RELEASE = `
local v = redis.call('DECR', KEYS[1])
if v <= 0 then redis.call('DEL', KEYS[1]) return 0 end
return v`;

/**
 * Per-tenant fair scheduling (§3.9) on open-source BullMQ, which has no group keys. Each queue
 * keeps a count of every tenant's jobs in flight; a new job's priority is that count. A tenant's
 * first job runs at priority 1, its thousandth at 1000, so a tenant with one job is never stuck
 * behind another tenant's million-row import: the queue interleaves tenants round-robin.
 */
export class FairScheduler {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly ttlSeconds = 86_400,
  ) {}

  private key(queue: string, tenantId: string) {
    return `${this.prefix}:fair:${queue}:${tenantId}`;
  }

  /** Reserve a slot for one more of the tenant's jobs and return the priority it should run at. */
  async admit(queue: string, tenantId: string): Promise<number> {
    const key = this.key(queue, tenantId);
    const [[, count]] = (await this.redis
      .multi()
      .incr(key)
      .expire(key, this.ttlSeconds)
      .exec()) as [[Error | null, number], unknown];
    return Math.min(Math.max(count, 1), MAX_PRIORITY);
  }

  /** The job finished (done or dead-lettered): free its slot. */
  async release(queue: string, tenantId: string): Promise<void> {
    await this.redis.eval(RELEASE, 1, this.key(queue, tenantId));
  }

  async inFlight(queue: string, tenantId: string): Promise<number> {
    return Number((await this.redis.get(this.key(queue, tenantId))) ?? 0);
  }
}
