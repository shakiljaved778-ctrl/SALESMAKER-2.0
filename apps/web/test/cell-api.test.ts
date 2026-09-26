import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Refresh tokens are single-use with reuse detection, so every needless refresh is a chance to
 * end the session (a navigation that drops the rotated cookie). These pin the discipline.
 */
type Handler = (url: string, init: RequestInit) => { status: number; body?: unknown };

let calls: { url: string; auth: string | undefined }[] = [];
let handler: Handler;
let tokens = 0;

function install(h: Handler) {
  handler = h;
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const auth = (init.headers as Record<string, string> | undefined)?.['authorization'];
    calls.push({ url, auth });
    const { status, body } = handler(url, init);
    return Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
}

const refreshes = () => calls.filter((c) => c.url === '/api/auth/refresh').length;
const refreshed = () => {
  tokens += 1;
  return {
    status: 200,
    body: { accessToken: `t${String(tokens)}`, accessTokenExpiresAt: '2099-01-01T00:00:00Z' },
  };
};

async function load() {
  vi.resetModules();
  return import('../src/lib/cell-api');
}

beforeEach(() => {
  calls = [];
  tokens = 0;
});

describe('cellApi', () => {
  it('waits for the page’s session instead of calling without a token: one refresh', async () => {
    install((url, init) => {
      if (url === '/api/auth/refresh') return refreshed();
      const auth = (init.headers as Record<string, string>)['authorization'];
      return auth ? { status: 200, body: { ok: true } } : { status: 401 };
    });
    const { cellApi } = await load();
    const results = await Promise.all([cellApi('GET', '/v1/me'), cellApi('GET', '/v1/users')]);
    expect(results.every((r) => r.ok)).toBe(true);
    // A later call finds the token and does not refresh again.
    expect((await cellApi('GET', '/v1/profiles')).ok).toBe(true);
    expect(refreshes()).toBe(1);
    expect(
      calls.filter((c) => c.url.startsWith('/api/v1/')).every((c) => c.auth === 'Bearer t1'),
    ).toBe(true);
  });

  it('refreshes an expired token once and retries with the new one', async () => {
    install((url, init) => {
      if (url === '/api/auth/refresh') return refreshed();
      const auth = (init.headers as Record<string, string>)['authorization'];
      return auth === 'Bearer t2' ? { status: 200, body: {} } : { status: 401 };
    });
    const { cellApi } = await load();
    const result = await cellApi('GET', '/v1/me'); // t1 from the page load, then expired
    expect(result.ok).toBe(true);
    expect(refreshes()).toBe(2);
    expect(calls.at(-1)?.auth).toBe('Bearer t2');
  });

  it('does not refresh again when another call already replaced the token', async () => {
    let expired = 't1';
    install((url, init) => {
      if (url === '/api/auth/refresh') return refreshed();
      const auth = (init.headers as Record<string, string>)['authorization'];
      return auth === `Bearer ${expired}` ? { status: 401 } : { status: 200, body: {} };
    });
    const { cellApi } = await load();
    expect((await cellApi('GET', '/v1/me')).ok).toBe(true); // t1: 401, refresh to t2, ok
    expect(refreshes()).toBe(2);
    // Two calls race on an expired t2: only one of them refreshes.
    expired = 't2';
    const [a, b] = await Promise.all([cellApi('GET', '/v1/a'), cellApi('GET', '/v1/b')]);
    expect(a.ok && b.ok).toBe(true);
    expect(refreshes()).toBe(3);
  });

  it('gives back the 401 when the session cannot be refreshed', async () => {
    install(() => ({ status: 401 }));
    const { cellApi } = await load();
    const result = await cellApi('GET', '/v1/me');
    expect(result).toMatchObject({ ok: false, status: 401 });
  });
});
