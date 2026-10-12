import { describe, expect, it } from 'vitest';

import { FakeCaptchaVerifier, TurnstileVerifier } from '../src/index.js';

const answering = (status: number, body: unknown, seen: { body?: string } = {}) =>
  (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.body = init?.body instanceof URLSearchParams ? init.body.toString() : '';
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as typeof fetch;

describe('Turnstile', () => {
  it('passes only on a successful siteverify answer, sending the token, secret and IP', async () => {
    const seen: { body?: string } = {};
    const ok = new TurnstileVerifier(
      'site',
      'secret',
      'http://t.test',
      answering(200, { success: true }, seen),
    );
    expect(await ok.verify('tok', '203.0.113.9')).toBe(true);
    expect(new URLSearchParams(seen.body)).toEqual(
      new URLSearchParams({ secret: 'secret', response: 'tok', remoteip: '203.0.113.9' }),
    );
    const no = new TurnstileVerifier(
      'site',
      'secret',
      'http://t.test',
      answering(200, { success: false }),
    );
    expect(await no.verify('tok')).toBe(false);
    const down = new TurnstileVerifier('site', 'secret', 'http://t.test', answering(500, {}));
    expect(await down.verify('tok')).toBe(false);
    const broken = new TurnstileVerifier('site', 'secret', 'http://t.test', () =>
      Promise.reject(new Error('offline')),
    );
    expect(await broken.verify('tok')).toBe(false);
    expect(await ok.verify('')).toBe(false);
  });

  it('has a fake for tests', async () => {
    const fake = new FakeCaptchaVerifier();
    expect(await fake.verify('pass')).toBe(true);
    expect(await fake.verify('nope')).toBe(false);
  });
});
