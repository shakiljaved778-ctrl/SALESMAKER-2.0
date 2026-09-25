import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const ENV = {
  CONTROL_API_BASE_URL: 'http://cp.test',
  WEB_BASE_DOMAIN: 'salesmaker.test',
};

describe('webEnv and bffDeps', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('validates the environment with defaults and caches it', async () => {
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
    const { webEnv } = await import('../src/server/env');
    expect(webEnv()).toEqual({ ...ENV, WEB_URL_SCHEME: 'https', TENANT_CACHE_TTL_SECONDS: 60 });
    vi.stubEnv('WEB_BASE_DOMAIN', 'changed.test');
    expect(webEnv().WEB_BASE_DOMAIN).toBe('salesmaker.test');
  });

  it('fails fast on an invalid environment', async () => {
    vi.stubEnv('CONTROL_API_BASE_URL', 'not a url');
    vi.stubEnv('WEB_BASE_DOMAIN', '');
    const { webEnv } = await import('../src/server/env');
    expect(() => webEnv()).toThrow(/CONTROL_API_BASE_URL[\s\S]*WEB_BASE_DOMAIN/);
  });

  it('builds one set of BFF dependencies per process from the environment', async () => {
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
    vi.stubEnv('WEB_URL_SCHEME', 'http');
    const { bffDeps } = await import('../src/server/deps');
    const deps = bffDeps();
    expect(deps).toMatchObject({ baseDomain: 'salesmaker.test', scheme: 'http' });
    expect(bffDeps()).toBe(deps);
  });
});
