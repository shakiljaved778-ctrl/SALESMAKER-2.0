import { createVerify, timingSafeEqual } from 'node:crypto';

import { convert } from 'html-to-text';
import { simpleParser } from 'mailparser';

/*
 * Inbound email (§7.1 email-to-lead). Mail arrives through an InboundEmailSource: Amazon SES in
 * cells (a receipt rule stores the message in the cell's bucket and notifies through SNS, whose
 * signature is verified here), a shared-secret source locally and in tests. The message itself is
 * parsed with mailparser.
 */

export interface ParsedEmail {
  messageId: string | null;
  from: { address: string; name: string | null } | null;
  subject: string | null;
  /** Plain text (HTML converted), capped. */
  text: string;
  date: Date | null;
}

const HTML_TO_TEXT = {
  wordwrap: false as const,
  selectors: [
    { selector: 'a', options: { ignoreHref: true } },
    { selector: 'img', format: 'skip' },
  ],
};

/** Parse a raw MIME message; attachments are ignored. */
export async function parseEmail(raw: Buffer, maxText = 20_000): Promise<ParsedEmail> {
  const mail = await simpleParser(raw, { skipImageLinks: true, skipTextLinks: true });
  const sender = mail.from?.value[0];
  const address = sender?.address?.trim().toLowerCase();
  return {
    messageId: mail.messageId?.slice(0, 500) ?? null,
    from: sender && address ? { address, name: sender.name.trim() || null } : null,
    subject: mail.subject?.trim().slice(0, 1000) || null,
    // HTML-only mail has no text part: convert it (links and images dropped).
    text: (mail.text || (typeof mail.html === 'string' ? convert(mail.html, HTML_TO_TEXT) : ''))
      .trim()
      .slice(0, maxText),
    date: mail.date ?? null,
  };
}

/** A message for these recipients: the bytes, or where the source already stored them. */
export interface InboundDelivery {
  recipients: string[];
  raw?: Buffer;
  /** Key in the cell's object storage (SES receipt rule S3 action). */
  storageKey?: string;
}

export type InboundResult = { kind: 'delivery'; delivery: InboundDelivery } | { kind: 'ignored' };

export interface InboundEmailSource {
  /**
   * The delivery in this request, `ignored` for a valid request that carries none (e.g. a
   * subscription confirmation), or null when the request is not from this source.
   */
  accept(headers: Record<string, string | undefined>, body: unknown): Promise<InboundResult | null>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** Locally and in tests: `x-sm-inbound-secret` and `{ recipients, raw (base64) }`. */
export class SecretInboundSource implements InboundEmailSource {
  constructor(private readonly secret: string) {}

  accept(headers: Record<string, string | undefined>, body: unknown) {
    const given = Buffer.from(headers['x-sm-inbound-secret'] ?? '');
    const expected = Buffer.from(this.secret);
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      return Promise.resolve(null);
    if (!isRecord(body) || typeof body['raw'] !== 'string')
      return Promise.resolve({ kind: 'ignored' as const });
    return Promise.resolve({
      kind: 'delivery' as const,
      delivery: {
        recipients: strings(body['recipients']),
        raw: Buffer.from(body['raw'], 'base64'),
      },
    });
  }
}

const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;
const NOTIFICATION_KEYS = ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'];
const SUBSCRIPTION_KEYS = [
  'Message',
  'MessageId',
  'SubscribeURL',
  'Timestamp',
  'Token',
  'TopicArn',
  'Type',
];
/** SNS messages older than this are refused (replays). */
const MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Amazon SES through SNS (in cells). Only messages from the configured topic, with a valid SNS
 * signature (certificate fetched from an SNS host only), less than an hour old. A subscription
 * confirmation is confirmed by visiting its SNS URL. A notification names the stored message
 * (S3 action into the cell's bucket) or carries it (SNS action, base64).
 */
export class SesSnsInboundSource implements InboundEmailSource {
  private readonly certs = new Map<string, string>();

  constructor(
    private readonly topicArn: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async cert(url: URL): Promise<string> {
    const hit = this.certs.get(url.href);
    if (hit) return hit;
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`SNS certificate answered ${String(res.status)}`);
    const pem = await res.text();
    this.certs.set(url.href, pem);
    return pem;
  }

  private async verified(m: Record<string, unknown>): Promise<boolean> {
    if (m['TopicArn'] !== this.topicArn) return false;
    const timestamp = Date.parse(String(m['Timestamp']));
    if (!Number.isFinite(timestamp) || Math.abs(this.now() - timestamp) > MAX_AGE_MS) return false;
    let certUrl: URL;
    try {
      certUrl = new URL(String(m['SigningCertURL']));
    } catch {
      return false;
    }
    if (certUrl.protocol !== 'https:' || !SNS_HOST.test(certUrl.hostname)) return false;
    if (!certUrl.pathname.endsWith('.pem')) return false;
    const keys = m['Type'] === 'Notification' ? NOTIFICATION_KEYS : SUBSCRIPTION_KEYS;
    const text = keys
      .filter((k) => typeof m[k] === 'string')
      .map((k) => `${k}\n${String(m[k])}\n`)
      .join('');
    const algorithm = m['SignatureVersion'] === '2' ? 'RSA-SHA256' : 'RSA-SHA1';
    try {
      const verifier = createVerify(algorithm);
      verifier.update(text, 'utf8');
      return verifier.verify(await this.cert(certUrl), String(m['Signature']), 'base64');
    } catch {
      return false;
    }
  }

  async accept(
    headers: Record<string, string | undefined>,
    body: unknown,
  ): Promise<InboundResult | null> {
    if (!headers['x-amz-sns-message-type'] || !isRecord(body)) return null;
    if (!(await this.verified(body))) return null;
    if (body['Type'] === 'SubscriptionConfirmation') {
      const url = new URL(String(body['SubscribeURL']));
      if (url.protocol === 'https:' && SNS_HOST.test(url.hostname))
        await this.fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
      return { kind: 'ignored' };
    }
    if (body['Type'] !== 'Notification') return { kind: 'ignored' };
    let message: unknown;
    try {
      message = JSON.parse(String(body['Message']));
    } catch {
      return { kind: 'ignored' };
    }
    if (!isRecord(message) || message['notificationType'] !== 'Received')
      return { kind: 'ignored' };
    const receipt = isRecord(message['receipt']) ? message['receipt'] : {};
    const action = isRecord(receipt['action']) ? receipt['action'] : {};
    const recipients = strings(receipt['recipients']);
    if (action['type'] === 'S3' && typeof action['objectKey'] === 'string')
      return { kind: 'delivery', delivery: { recipients, storageKey: action['objectKey'] } };
    if (typeof message['content'] === 'string')
      return {
        kind: 'delivery',
        delivery: { recipients, raw: Buffer.from(message['content'], 'base64') },
      };
    return { kind: 'ignored' };
  }
}
