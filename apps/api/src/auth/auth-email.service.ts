import { createHash } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { renderInvitationEmail, renderResetPasswordEmail, renderVerifyEmail } from '@sm/emails';
import type { EmailSender } from '@sm/integrations';
import type { Logger } from 'pino';

import type { ApiConfig } from '../config.js';
import { CONFIG, EMAIL_SENDER, LOGGER } from '../tokens.js';

interface Recipient {
  email: string;
  name: string;
  locale: string | null;
}

interface Workspace {
  name: string;
  slug: string;
}

export const VERIFY_EMAIL_TTL_HOURS = 24;
export const RESET_PASSWORD_TTL_MINUTES = 30;

/** Sends auth emails with links on the tenant's own subdomain. Failures are logged, not thrown. */
@Injectable()
export class AuthEmailService {
  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  link(workspace: Workspace, path: string, token: string): string {
    return `${this.config.WEB_URL_SCHEME}://${workspace.slug}.${this.config.WEB_BASE_DOMAIN}${path}?token=${encodeURIComponent(token)}`;
  }

  async sendVerification(
    to: Recipient,
    workspace: Workspace,
    token: string,
    tokenId: string,
  ): Promise<void> {
    const rendered = await renderVerifyEmail({
      locale: to.locale ?? 'en',
      name: to.name,
      workspace: workspace.name,
      url: this.link(workspace, '/verify-email', token),
      expiresInHours: VERIFY_EMAIL_TTL_HOURS,
    });
    await this.deliver({ to: to.email, ...rendered, idempotencyKey: `verify-email:${tokenId}` });
  }

  async sendPasswordReset(
    to: Recipient,
    workspace: Workspace,
    token: string,
    tokenId: string,
  ): Promise<void> {
    const rendered = await renderResetPasswordEmail({
      locale: to.locale ?? 'en',
      name: to.name,
      workspace: workspace.name,
      url: this.link(workspace, '/reset-password', token),
      expiresInMinutes: RESET_PASSWORD_TTL_MINUTES,
    });
    await this.deliver({ to: to.email, ...rendered, idempotencyKey: `reset-password:${tokenId}` });
  }

  async sendInvitation(
    to: Recipient,
    workspace: Workspace,
    inviter: string,
    token: string,
    expiresInDays: number,
  ): Promise<void> {
    const rendered = await renderInvitationEmail({
      locale: to.locale ?? 'en',
      name: to.name,
      inviter,
      workspace: workspace.name,
      url: this.link(workspace, '/accept-invite', token),
      expiresInDays,
    });
    // Key idempotency on a digest, so the token never reaches the provider outside the link.
    const digest = createHash('sha256').update(token).digest('hex').slice(0, 32);
    await this.deliver({
      to: to.email,
      ...rendered,
      idempotencyKey: `invitation:${digest}`,
    });
  }

  private async deliver(message: Parameters<EmailSender['send']>[0]): Promise<void> {
    try {
      await this.sender.send(message);
    } catch (err) {
      this.logger.error({ err }, 'auth email could not be sent');
    }
  }
}
