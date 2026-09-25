import { randomUUID } from 'node:crypto';

import type { EmailMessage, EmailSender } from './email-sender.js';

/** In-memory outbox for tests. Honours idempotency keys like the real senders must. */
export class FakeEmailSender implements EmailSender {
  readonly outbox: (EmailMessage & { messageId: string })[] = [];
  private readonly seen = new Map<string, string>();

  send(message: EmailMessage): Promise<{ messageId: string }> {
    const previous = message.idempotencyKey ? this.seen.get(message.idempotencyKey) : undefined;
    if (previous) return Promise.resolve({ messageId: previous });
    const messageId = randomUUID();
    this.outbox.push({ ...message, messageId });
    if (message.idempotencyKey) this.seen.set(message.idempotencyKey, messageId);
    return Promise.resolve({ messageId });
  }

  /** Most recent message sent to `to`, if any. */
  lastTo(to: string): (EmailMessage & { messageId: string }) | undefined {
    return this.outbox.filter((m) => m.to.toLowerCase() === to.toLowerCase()).at(-1);
  }
}
