/** Transactional email (§3.2 EmailSender): SES in deployed cells, SMTP to Mailpit locally. */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Idempotency / de-duplication key, e.g. `verify-email:<tokenId>` (golden rule 10). */
  idempotencyKey?: string;
  tags?: Record<string, string>;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<{ messageId: string }>;
}
