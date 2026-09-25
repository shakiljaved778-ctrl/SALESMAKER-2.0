import { describe, expect, it } from 'vitest';

import { ControlPlane } from '../src/server/control-plane';

const CELL = {
  id: 'eu-central-1',
  region: 'eu-central-1',
  label: 'Europe (Frankfurt)',
  apiBaseUrl: 'http://cell-eu.test',
  signupOpen: true,
};

function plane(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let now = 1_000;
  const cp = new ControlPlane({
    baseUrl: 'http://cp.test',
    ttlMs: 60_000,
    now: () => now,
    fetch: ((input: URL | string, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(respond(String(input), init));
    }) as typeof fetch,
  });
  return {
    cp,
    calls,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('ControlPlane.listCells', () => {
  it('fetches the region list once and serves it from cache until the TTL passes', async () => {
    const { cp, calls, advance } = plane(() => Response.json({ cells: [CELL] }));
    expect(await cp.listCells()).toEqual([CELL]);
    expect(await cp.listCells()).toEqual([CELL]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://cp.test/cp/v1/cells');
    advance(60_001);
    await cp.listCells();
    expect(calls).toHaveLength(2);
  });

  it('returns null (never caches) on an error status, a bad body or a network failure', async () => {
    for (const respond of [
      () => new Response('down', { status: 503 }),
      () => Response.json({ cells: [{ id: 'x' }] }),
      () => Promise.reject(new Error('ECONNREFUSED')),
    ]) {
      const { cp, calls } = plane(respond);
      expect(await cp.listCells()).toBeNull();
      expect(await cp.listCells()).toBeNull();
      expect(calls).toHaveLength(2);
    }
  });
});

describe('ControlPlane.findWorkspaces', () => {
  it('posts the email and locale and reports whether the request was accepted', async () => {
    const { cp, calls } = plane(() => new Response(null, { status: 202 }));
    expect(await cp.findWorkspaces('a@b.test', 'ar')).toBe(true);
    expect(calls[0]?.url).toBe('http://cp.test/cp/v1/workspaces/find');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ email: 'a@b.test', locale: 'ar' });
  });

  it('omits a missing locale and returns false on failure', async () => {
    const failing = plane(() => new Response(null, { status: 500 }));
    expect(await failing.cp.findWorkspaces('a@b.test', undefined)).toBe(false);
    expect(JSON.parse(failing.calls[0]?.init?.body as string)).toEqual({ email: 'a@b.test' });
    const offline = plane(() => Promise.reject(new Error('offline')));
    expect(await offline.cp.findWorkspaces('a@b.test', 'en')).toBe(false);
  });
});
