import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestApi, type TestApi } from './support.js';

let api: TestApi;

beforeAll(async () => {
  api = await startTestApi();
});

afterAll(async () => {
  await api.dispose();
});

describe('health probes', () => {
  it('reports liveness with the cell id', async () => {
    const res = await api.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'api', cell: 'eu-central-1' });
  });

  it('reports readiness when the database and cache answer', async () => {
    const res = await api.app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', checks: { database: 'ok', cache: 'ok' } });
  });

  it('is never rate limited', async () => {
    const statuses = new Set<number>();
    for (let i = 0; i < 5; i += 1)
      statuses.add((await api.app.inject({ method: 'GET', url: '/health' })).statusCode);
    expect([...statuses]).toEqual([200]);
  });
});

describe('errors', () => {
  it('answers unknown routes with a problem+json 404 and a trace id', async () => {
    const res = await api.app.inject({ method: 'GET', url: '/v1/records/lead' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ code: 'not_found', traceId: res.headers['x-request-id'] });
  });
});

describe('pre-auth rate limit (§3.6)', () => {
  it('returns 429 problem+json with RateLimit and Retry-After headers once the burst is spent', async () => {
    const limited = await startTestApi({ RATE_LIMIT_IP_BURST: 2, RATE_LIMIT_IP_PER_SECOND: 0.01 });
    try {
      const responses = [];
      for (let i = 0; i < 3; i += 1)
        responses.push(await limited.app.inject({ method: 'GET', url: '/v1/openapi.json' }));
      expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 429]);
      expect(responses[0]?.headers['ratelimit-limit']).toBe('2');
      expect(responses[0]?.headers['ratelimit-remaining']).toBe('1');
      const denied = responses[2];
      expect(denied?.headers['retry-after']).toBeDefined();
      expect(denied?.json()).toMatchObject({ code: 'rate_limited', status: 429 });
    } finally {
      await limited.dispose();
    }
  });
});

describe('graceful degradation (§11.3)', () => {
  it('starts without Valkey, reports degraded readiness, and keeps serving (rate limiter fails open)', async () => {
    const degraded = await startTestApi({ REDIS_URL: 'redis://127.0.0.1:1' });
    try {
      const ready = await degraded.app.inject({ method: 'GET', url: '/health/ready' });
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toEqual({
        status: 'degraded',
        checks: { database: 'ok', cache: 'failing' },
      });
      const served = await degraded.app.inject({ method: 'GET', url: '/v1/openapi.json' });
      expect(served.statusCode).toBe(200);
    } finally {
      await degraded.dispose();
    }
  });
});
