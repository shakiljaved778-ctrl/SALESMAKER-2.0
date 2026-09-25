import { RangeApiBreachedPasswordChecker } from '@sm/integrations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildFakesServer } from '../src/server.js';

const app = buildFakesServer();
let baseUrl = '';

beforeAll(async () => {
  baseUrl = `${await app.listen({ port: 0, host: '127.0.0.1' })}/hibp`;
});

afterAll(async () => {
  await app.close();
});

describe('fake HIBP range API', () => {
  it('reports the known breached passwords through the real client adapter', async () => {
    const checker = new RangeApiBreachedPasswordChecker(baseUrl);
    expect(await checker.breachCount('password1234')).toBeGreaterThan(0);
    expect(await checker.breachCount('a long and unusual passphrase 7731')).toBe(0);
  });

  it('rejects malformed prefixes', async () => {
    const res = await app.inject({ method: 'GET', url: '/hibp/range/XYZ' });
    expect(res.statusCode).toBe(400);
  });
});
