import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  FakeEmailSender,
  RangeApiBreachedPasswordChecker,
  sha1Upper,
  SmtpEmailSender,
} from '../src/index.js';
import { startFakeSmtpServer, type FakeSmtpServer } from './fake-smtp-server.js';

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
  let smtp: FakeSmtpServer;
  beforeAll(async () => {
    smtp = await startFakeSmtpServer();
  });
  afterAll(async () => {
    await smtp.close();
  });

  it('delivers over SMTP with the idempotency and tag headers', async () => {
    const sender = new SmtpEmailSender(
      `smtp://127.0.0.1:${String(smtp.port)}`,
      'SalesMaker <no-reply@salesmaker.localhost>',
    );
    const { messageId } = await sender.send({
      to: 'dev@salesmaker.localhost',
      subject: 'Test',
      html: '<p>t</p>',
      text: 't',
      idempotencyKey: 'key-1',
      tags: { kind: 'verify' },
    });
    expect(messageId).toMatch(/@/);
    const [mail] = smtp.messages;
    expect(mail?.from).toBe('no-reply@salesmaker.localhost');
    expect(mail?.to).toEqual(['dev@salesmaker.localhost']);
    expect(mail?.data).toMatch(/^Subject: Test$/m);
    expect(mail?.data).toMatch(/^X-SM-Idempotency-Key: key-1$/im);
    expect(mail?.data).toMatch(/^X-SM-Tag-kind: verify$/im);
  });

  it('sends no custom headers when none are given', async () => {
    const sender = new SmtpEmailSender(`smtp://127.0.0.1:${String(smtp.port)}`, 'a@b.test');
    await sender.send({ to: 'x@y.test', subject: 'Plain', html: '<p>p</p>', text: 'p' });
    const mail = smtp.messages.at(-1);
    expect(mail?.data).not.toMatch(/X-SM-/i);
  });
});
