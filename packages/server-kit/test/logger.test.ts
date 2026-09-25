import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLogger, requestContext, scrubPii } from '../src/index.js';

describe('scrubPii (§11.4)', () => {
  it('masks emails and phone numbers', () => {
    expect(scrubPii('login failed for Jane.Doe+x@example.co.uk')).toBe('login failed for [email]');
    expect(scrubPii('call +974 5512 3456 or (415) 555-0134 or 050-123-4567')).toBe(
      'call [phone] or [phone] or [phone]',
    );
  });

  it('leaves ids, request ids, versions and counts alone', () => {
    const untouched = [
      'tenant 01920000-0000-7000-8000-00000000000a',
      'request 0192a4c1-7d3e-7b21-9f00-12ab34cd56ef',
      'node v22.22.2 took 1234 ms for 50 rows',
      'status 404 at 2026-09-25T09:30:00Z',
    ];
    for (const text of untouched) expect(scrubPii(text), text).toBe(text);
  });
});

function capture() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      cb();
    },
  });
  return { lines, logger: createLogger({ service: 'test', destination }) };
}

describe('createLogger', () => {
  it('redacts secrets and scrubs PII in nested fields and messages', () => {
    const { lines, logger } = capture();
    logger.info(
      {
        req: { headers: { authorization: 'Bearer abc', cookie: 'sm_rt=xyz' } },
        body: { password: 'hunter22', email: 'a@b.io' },
      },
      'signup for a@b.io',
    );
    expect(lines[0]).toMatchObject({
      req: { headers: { authorization: '[redacted]', cookie: '[redacted]' } },
      body: { password: '[redacted]', email: '[email]' },
      msg: 'signup for [email]',
      service: 'test',
    });
  });

  it('adds request, tenant and user ids from the request context', () => {
    const { lines, logger } = capture();
    requestContext.run({ requestId: 'req-12345678', dbStatements: 0 }, () => {
      requestContext.identify(
        '01920000-0000-7000-8000-00000000000a',
        '01920000-0000-7000-8000-0000000000ff',
      );
      logger.info('hello');
    });
    expect(lines[0]).toMatchObject({
      requestId: 'req-12345678',
      tenantId: '01920000-0000-7000-8000-00000000000a',
      userId: '01920000-0000-7000-8000-0000000000ff',
    });
  });
});
