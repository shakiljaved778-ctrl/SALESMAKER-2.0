import {
  deserialisePermissions,
  serialisePermissions,
  type EffectivePermissions,
  type SerialisedPermissions,
} from './engine.js';

/** The slice of a Valkey client the cache needs (ioredis satisfies it). */
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
}

/**
 * Effective permissions cached per user under the tenant's `permVersion` (§6.4, P01 plan §3.1).
 * Every change that can alter them bumps `permVersion` in the same transaction, so a stale entry is
 * never read: it simply stops being addressed, and expires. A cache failure falls back to computing.
 */
export class PermissionCache {
  constructor(
    private readonly store: CacheStore,
    private readonly ttlSeconds = 3600,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  static key(tenantId: string, userId: string, permVersion: number): string {
    return `perm:${tenantId}:${userId}:${String(permVersion)}`;
  }

  async getOrCompute(
    tenantId: string,
    userId: string,
    permVersion: number,
    compute: () => Promise<EffectivePermissions>,
  ): Promise<EffectivePermissions> {
    const key = PermissionCache.key(tenantId, userId, permVersion);
    try {
      const cached = await this.store.get(key);
      if (cached) return deserialisePermissions(JSON.parse(cached) as SerialisedPermissions);
    } catch (error) {
      this.onError(error);
    }
    const computed = await compute();
    try {
      await this.store.set(
        key,
        JSON.stringify(serialisePermissions(computed)),
        'EX',
        this.ttlSeconds,
      );
    } catch (error) {
      this.onError(error);
    }
    return computed;
  }
}
