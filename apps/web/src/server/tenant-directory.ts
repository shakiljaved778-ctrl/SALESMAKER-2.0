import { ResolvedTenant } from '@sm/contracts';
import type { z } from 'zod';

export type Tenant = z.infer<typeof ResolvedTenant>;

/** The control plane could not answer; callers show the maintenance state, never "not found". */
export class DirectoryUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('Tenant directory unavailable', { cause });
    this.name = 'DirectoryUnavailableError';
  }
}

interface Entry {
  tenant: Tenant | null;
  expiresAt: number;
}

export interface TenantDirectoryOptions {
  baseUrl: string;
  ttlMs: number;
  /** Unknown hosts are remembered briefly so a typo can't hammer the control plane. */
  negativeTtlMs?: number;
  maxEntries?: number;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Host → tenant and cell, from the control plane's public resolve endpoint (§3.4). The cell's API
 * URL always comes from here, never from configuration. Results are cached per host (bounded,
 * least recently used first out); only the directory's own answer is cached, never an outage.
 */
export class TenantDirectory {
  private readonly cache = new Map<string, Entry>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: TenantDirectoryOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async resolve(host: string): Promise<Tenant | null> {
    const key = host.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > this.now()) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit.tenant;
    }

    const url = new URL('/cp/v1/tenants/resolve', this.options.baseUrl);
    url.searchParams.set('host', key);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 3000),
      });
    } catch (err) {
      throw new DirectoryUnavailableError(err);
    }

    let tenant: Tenant | null;
    if (response.status === 404) {
      tenant = null;
    } else if (response.ok) {
      const parsed = ResolvedTenant.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success) throw new DirectoryUnavailableError(parsed.error);
      tenant = parsed.data;
    } else {
      throw new DirectoryUnavailableError(new Error(`HTTP ${String(response.status)}`));
    }

    const ttl = tenant ? this.options.ttlMs : (this.options.negativeTtlMs ?? 10_000);
    if (ttl > 0) this.remember(key, { tenant, expiresAt: this.now() + ttl });
    return tenant;
  }

  private remember(key: string, entry: Entry) {
    this.cache.delete(key);
    this.cache.set(key, entry);
    const max = this.options.maxEntries ?? 1000;
    while (this.cache.size > max) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
