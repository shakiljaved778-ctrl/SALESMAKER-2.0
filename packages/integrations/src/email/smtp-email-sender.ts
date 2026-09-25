import nodemailer, { type Transporter } from 'nodemailer';

import type { EmailMessage, EmailSender } from './email-sender.js';

/**
 * SMTP adapter. Locally it points at Mailpit (smtp://localhost:1025), which captures mail and
 * never delivers it, so development and e2e tests send nothing real (§0.3).
 */
export class SmtpEmailSender implements EmailSender {
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }

  async send(message: EmailMessage): Promise<{ messageId: string }> {
    const info = await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      headers: {
        ...(message.idempotencyKey ? { 'X-SM-Idempotency-Key': message.idempotencyKey } : {}),
        ...Object.fromEntries(
          Object.entries(message.tags ?? {}).map(([k, v]) => [`X-SM-Tag-${k}`, v]),
        ),
      },
    });
    return { messageId: info.messageId };
  }
}
