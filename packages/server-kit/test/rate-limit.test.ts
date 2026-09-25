import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { rateLimitHeaders, TokenBucketRateLimiter } from '../src/index.js';

let container: StartedTestContainer | undefined;
let redis: Redis;

beforeAll(async () => {
  let url = process.env['TEST_REDIS_URL'];
  if (!url) {
    container = await new GenericContainer('valkey/valkey:8-alpine').withExposedPorts(6379).start();
    url = `redis://${container.getHost()}:${String(container.getMappedPort(6379))}`;
  }
  redis = new Redis(url);
});

afterAll(async () => {
  redis.disconnect();
  await container?.stop();
});

describe('TokenBucketRateLimiter', () => {
  it('allows a burst up to capacity, then refuses with a reset hint', async () => {
    const limiter = new TokenBucketRateLimiter(redis, `test-${String(Date.now())}`);
    const policy = { capacity: 3, refillPerSecond: 1 };
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await limiter.consume('tenant:a', policy));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
    expect(results[3]?.resetSeconds).toBe(1);
    const first = results[0];
    if (!first) throw new Error('no result');
    expect(rateLimitHeaders(first)).toEqual({
      'RateLimit-Limit': '3',
      'RateLimit-Remaining': '2',
      'RateLimit-Reset': '0',
    });
  });

  it('keeps buckets independent per key', async () => {
    const limiter = new TokenBucketRateLimiter(redis, `test-${String(Date.now())}-b`);
    const policy = { capacity: 1, refillPerSecond: 0.1 };
    expect((await limiter.consume('tenant:a', policy)).allowed).toBe(true);
    expect((await limiter.consume('tenant:a', policy)).allowed).toBe(false);
    expect((await limiter.consume('tenant:b', policy)).allowed).toBe(true);
  });

  it('refills over time', async () => {
    const limiter = new TokenBucketRateLimiter(redis, `test-${String(Date.now())}-c`);
    const policy = { capacity: 1, refillPerSecond: 20 };
    expect((await limiter.consume('k', policy)).allowed).toBe(true);
    expect((await limiter.consume('k', policy)).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 120));
    expect((await limiter.consume('k', policy)).allowed).toBe(true);
  });
});
