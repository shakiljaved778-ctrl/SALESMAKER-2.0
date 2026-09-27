import { MetadataIndex, type TenantMetadata } from './runtime.js';

/** The slice of a Valkey client the cache needs (ioredis satisfies it). */
export interface MetadataStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
}

export interface MetadataCacheOptions {
  /** In-process entries kept (one per tenant and version). */
  maxEntries?: number;
  ttlSeconds?: number;
  onError?: (error: unknown) => void;
}

/**
 * Per-tenant metadata, cached in process (LRU) and in Valkey under `metadataVersion` (§3.10).
 * Every metadata change bumps the version in its own transaction, so a stale copy is never
 * addressed again: it ages out. A Valkey failure falls back to loading, and is reported.
 */
export class MetadataCache {
  private readonly local = new Map<string, MetadataIndex>();
  private readonly maxEntries: number;
  private readonly ttlSeconds: number;
  private readonly onError: (error: unknown) => void;

  constructor(
    private readonly store: MetadataStore | null,
    options: MetadataCacheOptions = {},
  ) {
    this.maxEntries = options.maxEntries ?? 500;
    this.ttlSeconds = options.ttlSeconds ?? 3600;
    this.onError = options.onError ?? (() => undefined);
  }

  static key(tenantId: string, version: number): string {
    return `meta:${tenantId}:${String(version)}`;
  }

  async getOrLoad(
    tenantId: string,
    version: number,
    load: () => Promise<TenantMetadata>,
  ): Promise<MetadataIndex> {
    const key = MetadataCache.key(tenantId, version);
    const hit = this.local.get(key);
    if (hit) {
      // Refresh recency.
      this.local.delete(key);
      this.local.set(key, hit);
      return hit;
    }
    let metadata: TenantMetadata | null = null;
    if (this.store) {
      try {
        const raw = await this.store.get(key);
        if (raw) metadata = JSON.parse(raw) as TenantMetadata;
      } catch (error) {
        this.onError(error);
      }
    }
    if (!metadata) {
      metadata = await load();
      if (this.store) {
        try {
          await this.store.set(key, JSON.stringify(metadata), 'EX', this.ttlSeconds);
        } catch (error) {
          this.onError(error);
        }
      }
    }
    const index = new MetadataIndex(metadata);
    this.local.set(key, index);
    while (this.local.size > this.maxEntries) {
      const oldest = this.local.keys().next().value;
      if (oldest === undefined) break;
      this.local.delete(oldest);
    }
    return index;
  }
}
