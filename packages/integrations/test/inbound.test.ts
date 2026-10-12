import { createSign, generateKeyPairSync } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { parseEmail, SecretInboundSource, SesSnsInboundSource } from '../src/index.js';

const MIME = [
  'From: "Jane Doe" <Jane.Doe@Acme.example>',
  'To: leads-abc@in.salesmaker.test',
  'Subject: Pricing for 40 seats',
  'Message-ID: <m1@acme.example>',
  'Date: Mon, 12 Oct 2026 09:00:00 +0000',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="b"',
  '',
  '--b',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Hello,<br>we need <b>40</b> seats.</p>',
  '--b--',
  '',
].join('\r\n');

describe('parseEmail', () => {
  it('reads the sender, subject, id and text (from HTML when there is no text part)', async () => {
    const parsed = await parseEmail(Buffer.from(MIME));
    expect(parsed).toMatchObject({
      messageId: '<m1@acme.example>',
      from: { address: 'jane.doe@acme.example', name: 'Jane Doe' },
      subject: 'Pricing for 40 seats',
    });
    expect(parsed.text).toContain('we need 40 seats.');
    expect((await parseEmail(Buffer.from(MIME), 10)).text).toHaveLength(10);
    expect(await parseEmail(Buffer.from('not an email'))).toMatchObject({ from: null });
  });
});

describe('the shared-secret source', () => {
  it('accepts its secret only', async () => {
    const source = new SecretInboundSource('s3cret-value');
    const body = { recipients: ['a@b.test'], raw: Buffer.from(MIME).toString('base64') };
    expect(await source.accept({ 'x-sm-inbound-secret': 'wrong-value!' }, body)).toBeNull();
    expect(await source.accept({}, body)).toBeNull();
    const ok = await source.accept({ 'x-sm-inbound-secret': 's3cret-value' }, body);
    expect(ok).toMatchObject({ kind: 'delivery', delivery: { recipients: ['a@b.test'] } });
    expect(ok?.kind === 'delivery' && ok.delivery.raw.toString()).toBe(MIME);
  });
});

describe('the SES (SNS) source', () => {
  const TOPIC = 'arn:aws:sns:eu-central-1:123456789012:inbound';
  const CERT = 'https://sns.eu-central-1.amazonaws.com/SimpleNotificationService-abc.pem';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const NOW = Date.parse('2026-10-12T10:00:00Z');

  const sign = (m: Record<string, string>, version = '1') => {
    const keys =
      m['Type'] === 'Notification'
        ? ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type']
        : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
    const text = keys
      .filter((k) => m[k] !== undefined)
      .map((k) => `${k}\n${m[k] ?? ''}\n`)
      .join('');
    const signer = createSign(version === '2' ? 'RSA-SHA256' : 'RSA-SHA1');
    signer.update(text);
    return {
      ...m,
      SignatureVersion: version,
      SigningCertURL: CERT,
      Signature: signer.sign(privateKey, 'base64'),
    };
  };
  const notification = (message: unknown, extra: Record<string, string> = {}) => ({
    Type: 'Notification',
    MessageId: 'n1',
    TopicArn: TOPIC,
    Message: JSON.stringify(message),
    Timestamp: '2026-10-12T09:59:00.000Z',
    ...extra,
  });
  const received = {
    notificationType: 'Received',
    receipt: {
      recipients: ['leads-x@in.salesmaker.test'],
      action: { type: 'S3', bucketName: 'cell', objectKey: 'inbound/abc' },
    },
  };
  const setup = () => {
    const fetchMock = vi.fn<typeof fetch>((input) =>
      Promise.resolve(
        (input instanceof URL ? input.href : JSON.stringify(input)).endsWith('.pem')
          ? new Response(publicKey.export({ type: 'spki', format: 'pem' }))
          : new Response('ok'),
      ),
    );
    return { source: new SesSnsInboundSource(TOPIC, fetchMock, () => NOW), fetchMock };
  };
  const H = { 'x-amz-sns-message-type': 'Notification' };

  it('takes signed notifications of received mail from its topic', async () => {
    const { source, fetchMock } = setup();
    expect(await source.accept(H, sign(notification(received)))).toEqual({
      kind: 'delivery',
      delivery: { recipients: ['leads-x@in.salesmaker.test'], storageKey: 'inbound/abc' },
    });
    expect(
      await source.accept(H, sign(notification(received, { Subject: 'x' }), '2')),
    ).toMatchObject({ kind: 'delivery' });
    // The certificate is fetched once.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const inline = {
      ...received,
      receipt: { ...received.receipt, action: { type: 'SNS' } },
      content: Buffer.from(MIME).toString('base64'),
    };
    const out = await source.accept(H, sign(notification(inline)));
    expect(out?.kind === 'delivery' && out.delivery.raw?.toString()).toBe(MIME);
  });

  it('refuses anything not signed for its topic, recent, from an SNS host', async () => {
    const { source, fetchMock } = setup();
    const good = sign(notification(received));
    expect(await source.accept({}, good)).toBeNull();
    expect(await source.accept(H, { ...good, Message: '{}' })).toBeNull();
    expect(
      await source.accept(H, sign(notification(received, { TopicArn: 'arn:other' }))),
    ).toBeNull();
    expect(
      await source.accept(H, sign(notification(received, { Timestamp: '2026-10-12T07:00:00Z' }))),
    ).toBeNull();
    const evil = { ...good, SigningCertURL: 'https://evil.example/cert.pem' };
    expect(await source.accept(H, evil)).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => u instanceof URL && u.href.includes('evil'))).toBe(
      false,
    );
  });

  it('confirms its subscription and ignores other notifications', async () => {
    const { source, fetchMock } = setup();
    const confirm = sign({
      Type: 'SubscriptionConfirmation',
      MessageId: 's1',
      TopicArn: TOPIC,
      Token: 't',
      Message: 'confirm',
      SubscribeURL: 'https://sns.eu-central-1.amazonaws.com/?Action=ConfirmSubscription&Token=t',
      Timestamp: '2026-10-12T09:59:00.000Z',
    });
    expect(
      await source.accept({ 'x-amz-sns-message-type': 'SubscriptionConfirmation' }, confirm),
    ).toEqual({
      kind: 'ignored',
    });
    expect(
      fetchMock.mock.calls.some(
        ([u]) => u instanceof URL && u.href.includes('ConfirmSubscription'),
      ),
    ).toBe(true);
    expect(await source.accept(H, sign(notification({ notificationType: 'Bounce' })))).toEqual({
      kind: 'ignored',
    });
  });
});
