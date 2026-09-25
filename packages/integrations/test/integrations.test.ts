import { describe, expect, it } from 'vitest';

import {
  FakeEmailSender,
  RangeApiBreachedPasswordChecker,
  sha1Upper,
  SmtpEmailSender,
} from '../src/index.js';

describe('RangeApiBreachedPasswordChecker', () => {
  it('sends only the 5-character prefix and finds the suffix in the response', async () => {
    const hash = sha1Upper('password1234');
    const requested: string[] = [];
    const fakeFetch = ((url: string) => {
      requested.push(url);
      return Promise.resolve(
        new Response(`0000000000000000000000000000000000A:1\r\n${hash.slice(5)}:3861\r\n`),
      );
    }) as typeof fetch;
    const checker = new RangeApiBreachedPasswordChecker('https://range.test/', fakeFetch);
    expect(await checker.breachCount('password1234')).toBe(3861);
    expect(requested).toEqual([`https://range.test/range/${hash.slice(0, 5)}`]);
    expect(requested[0]).not.toContain(hash.slice(5));
  });

  it('returns 0 when the suffix is absent and throws on a server error', async () => {
    const empty = new RangeApiBreachedPasswordChecker('https://range.test', () =>
      Promise.resolve(new Response('ABC:1')),
    );
    expect(await empty.breachCount('a very unusual passphrase 91')).toBe(0);
    const failing = new RangeApiBreachedPasswordChecker('https://range.test', () =>
      Promise.resolve(new Response('nope', { status: 503 })),
    );
    await expect(failing.breachCount('x')).rejects.toThrow('503');
  });
});

describe('FakeEmailSender', () => {
  it('records messages and de-duplicates by idempotency key', async () => {
    const sender = new FakeEmailSender();
    const msg = {
      to: 'a@b.test',
      subject: 'Hi',
      html: '<p>Hi</p>',
      text: 'Hi',
      idempotencyKey: 'k1',
    };
    const first = await sender.send(msg);
    const second = await sender.send(msg);
    expect(second.messageId).toBe(first.messageId);
    expect(sender.outbox).toHaveLength(1);
    expect(sender.lastTo('A@B.test')?.subject).toBe('Hi');
  });
});

describe('SmtpEmailSender', () => {
  it.skipIf(!process.env['TEST_SMTP_URL'])('delivers to the local SMTP catcher', async () => {
    const sender = new SmtpEmailSender(
      process.env['TEST_SMTP_URL'] ?? '',
      'SalesMaker <no-reply@salesmaker.localhost>',
    );
    const { messageId } = await sender.send({
      to: 'dev@salesmaker.localhost',
      subject: 'Test',
      html: '<p>t</p>',
      text: 't',
    });
    expect(messageId).toMatch(/@/);
  });
});
