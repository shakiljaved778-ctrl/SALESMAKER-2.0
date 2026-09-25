import { describe, expect, it, vi } from 'vitest';

import { classifyHost } from '../src/server/host';
import { DirectoryUnavailableError, TenantDirectory } from '../src/server/tenant-directory';

const ACME = {
  tenantId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  slug: 'acme',
  name: 'Acme Ltd',
  status: 'ACTIVE',
  cell: { id: 'eu-central-1', apiBaseUrl: 'http://cell-eu.test' },
};

describe('classifyHost', () => {
  const base = 'localhost:3000';
  it('treats the bare base domain and www as the apex', () => {
    expect(classifyHost('localhost:3000', base)).toEqual({ kind: 'apex' });
    expect(classifyHost('WWW.localhost:3000', base)).toEqual({ kind: 'apex' });
  });

  it('treats subdomains and custom domains as workspace hosts, lower-cased', () => {
    expect(classifyHost('Acme.localhost:3000', base)).toEqual({
      kind: 'workspace',
      host: 'acme.localhost:3000',
    });
    expect(classifyHost('crm.acme.com', base)).toEqual({ kind: 'workspace', host: 'crm.acme.com' });
  });

  it('rejects missing and malformed hosts before any lookup', () => {
    for (const bad of [
      null,
      '',
      'acme..localhost',
      'a b.com',
      'evil.com/x',
      '-a.com',
      'a'.repeat(254),
    ]) {
      expect(classifyHost(bad, base)).toEqual({ kind: 'invalid' });
    }
  });
});

function directoryWith(
  handler: (url: URL) => Response | Promise<Response>,
  options: { ttlMs?: number; negativeTtlMs?: number; maxEntries?: number } = {},
) {
  let now = 1_000_000;
  const fetchMock = vi.fn<typeof fetch>((input) =>
    Promise.resolve(handler(new URL(input instanceof Request ? input.url : input.toString()))),
  );
  const directory = new TenantDirectory({
    baseUrl: 'http://control-api.test',
    ttlMs: options.ttlMs ?? 60_000,
    negativeTtlMs: options.negativeTtlMs ?? 10_000,
    ...(options.maxEntries ? { maxEntries: options.maxEntries } : {}),
    fetch: fetchMock,
    now: () => now,
  });
  return {
    directory,
    fetchMock,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('TenantDirectory', () => {
  it('resolves a host through the control plane and caches it for the TTL', async () => {
    const { directory, fetchMock, advance } = directoryWith((url) => {
      expect(url.pathname).toBe('/cp/v1/tenants/resolve');
      expect(url.searchParams.get('host')).toBe('acme.localhost:3000');
      return Response.json(ACME);
    });
    expect(await directory.resolve('ACME.localhost:3000')).toEqual(ACME);
    expect(await directory.resolve('acme.localhost:3000')).toEqual(ACME);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    advance(60_001);
    await directory.resolve('acme.localhost:3000');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null for unknown hosts and remembers that only briefly', async () => {
    const { directory, fetchMock, advance } = directoryWith(() =>
      Response.json({ code: 'not_found' }, { status: 404 }),
    );
    expect(await directory.resolve('nope.localhost:3000')).toBeNull();
    expect(await directory.resolve('nope.localhost:3000')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    advance(10_001);
    await directory.resolve('nope.localhost:3000');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports outages and malformed answers as unavailable, and never caches them', async () => {
    let mode: 'down' | '500' | 'garbage' | 'ok' = 'down';
    const { directory, fetchMock } = directoryWith(() => {
      if (mode === 'down') throw new TypeError('fetch failed');
      if (mode === '500') return new Response('oops', { status: 500 });
      if (mode === 'garbage') return Response.json({ tenantId: 'x' });
      return Response.json(ACME);
    });
    for (const m of ['down', '500', 'garbage'] as const) {
      mode = m;
      await expect(directory.resolve('acme.localhost:3000')).rejects.toBeInstanceOf(
        DirectoryUnavailableError,
      );
    }
    mode = 'ok';
    expect(await directory.resolve('acme.localhost:3000')).toEqual(ACME);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('keeps the cache bounded, evicting the least recently used host', async () => {
    const { directory, fetchMock } = directoryWith(
      (url) => Response.json({ ...ACME, slug: url.searchParams.get('host')?.split('.')[0] }),
      { maxEntries: 2 },
    );
    await directory.resolve('aaa.x.test');
    await directory.resolve('bbb.x.test');
    await directory.resolve('aaa.x.test'); // aaa is now most recent
    await directory.resolve('ccc.x.test'); // evicts bbb
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await directory.resolve('aaa.x.test');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await directory.resolve('bbb.x.test');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
