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

export interface Codec<T> {
  encode(value: T): string;
  decode(raw: string): T;
}

const json = <T>(): Codec<T> => ({
  encode: (v) => JSON.stringify(v),
  decode: (raw) => JSON.parse(raw) as T,
});

/**
 * A per-user value cached under the tenant's `permVersion` (§6.4). Every change that can alter
 * it bumps `permVersion` in the same transaction, so a stale entry is never read: it stops being
 * addressed, and expires. A cache failure falls back to computing, and is reported.
 */
export class VersionedCache<T> {
  constructor(
    private readonly store: CacheStore,
    private readonly namespace: string,
    private readonly options: {
      ttlSeconds?: number;
      codec?: Codec<T>;
      onError?: (error: unknown) => void;
    } = {},
  ) {}

  key(tenantId: string, userId: string, permVersion: number): string {
    return `${this.namespace}:${tenantId}:${userId}:${String(permVersion)}`;
  }

  async getOrCompute(
    tenantId: string,
    userId: string,
    permVersion: number,
    compute: () => Promise<T>,
  ): Promise<T> {
    const { ttlSeconds = 3600, codec = json<T>(), onError = () => undefined } = this.options;
    const key = this.key(tenantId, userId, permVersion);
    try {
      const cached = await this.store.get(key);
      if (cached) return codec.decode(cached);
    } catch (error) {
      onError(error);
    }
    const computed = await compute();
    try {
      await this.store.set(key, codec.encode(computed), 'EX', ttlSeconds);
    } catch (error) {
      onError(error);
    }
    return computed;
  }
}

/** Effective permissions per user, cached under `perm:{tenant}:{user}:{permVersion}`. */
export class PermissionCache extends VersionedCache<EffectivePermissions> {
  constructor(store: CacheStore, ttlSeconds = 3600, onError?: (error: unknown) => void) {
    super(store, 'perm', {
      ttlSeconds,
      codec: {
        encode: (p) => JSON.stringify(serialisePermissions(p)),
        decode: (raw) => deserialisePermissions(JSON.parse(raw) as SerialisedPermissions),
      },
      ...(onError ? { onError } : {}),
    });
  }

  static key(tenantId: string, userId: string, permVersion: number): string {
    return `perm:${tenantId}:${userId}:${String(permVersion)}`;
  }
}
