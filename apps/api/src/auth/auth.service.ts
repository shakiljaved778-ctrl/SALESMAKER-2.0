import { Inject, Injectable } from '@nestjs/common';
import { withTenant, type CellPrisma, type TenantTransaction } from '@sm/db';
import { DomainError, emailRoutingHmac, errors } from '@sm/server-kit';

import type { ApiConfig } from '../config.js';
import { CONFIG, PRISMA } from '../tokens.js';
import {
  AuthEmailService,
  RESET_PASSWORD_TTL_MINUTES,
  VERIFY_EMAIL_TTL_HOURS,
} from './auth-email.service.js';
import { LockoutService } from './lockout.service.js';
import { PasswordService } from './password.service.js';
import { SessionService, type IssuedTokens } from './session.service.js';
import { newOneTimeToken, sha256, TokenService } from './token.service.js';

export interface ClientInfo {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export type LoginResult =
  | { status: 'ok'; tokens: IssuedTokens; user: MeDto }
  | { status: 'mfa_required'; mfaToken: string; expiresAt: string };

export interface MeDto {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  emailVerified: boolean;
  locale: string | null;
  timezone: string | null;
  theme: 'light' | 'dark' | 'system';
  density: 'comfortable' | 'default' | 'compact';
  mfaEnabled: boolean;
  workspace: { name: string; slug: string };
}

const invalidCredentials = () => errors.unauthenticated("That email and password don't match");

@Injectable()
export class AuthService {
  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly passwords: PasswordService,
    private readonly lockout: LockoutService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly mail: AuthEmailService,
  ) {}

  /** The workspace named by a pre-auth request must exist in this cell; otherwise 404. */
  async assertTenant(tenantId: string): Promise<{ name: string; slug: string }> {
    const settings = await withTenant(this.prisma, { tenantId }, ({ prisma }) =>
      prisma.tenantSettings.findUnique({ where: { tenantId }, select: { name: true, slug: true } }),
    );
    if (!settings) throw errors.notFound('Workspace');
    return settings;
  }

  /**
   * Create a password user (signup owner in T13; invitations in P01). The password is checked
   * against breaches and hashed before the transaction; the verification email follows commit.
   */
  async createPasswordUser(
    tx: TenantTransaction,
    input: { email: string; name: string; passwordHash: string; locale?: string | undefined },
  ): Promise<{ userId: string; verification: { token: string; tokenId: string } }> {
    const { prisma, context } = tx;
    const user = await prisma.user.create({
      data: {
        tenantId: context.tenantId,
        email: input.email,
        name: input.name,
        locale: input.locale ?? null,
        status: 'PENDING',
      },
    });
    await prisma.userIdentity.create({
      data: {
        tenantId: context.tenantId,
        userId: user.id,
        provider: 'password',
        subject: user.id,
        passwordHash: input.passwordHash,
      },
    });
    const verification = await this.createToken(
      tx,
      user.id,
      'verify_email',
      VERIFY_EMAIL_TTL_HOURS * 3600,
    );
    return { userId: user.id, verification };
  }

  async login(
    tenantId: string,
    email: string,
    password: string,
    client: ClientInfo,
  ): Promise<LoginResult> {
    const emailHash = this.emailHash(email);
    const found = await withTenant(this.prisma, { tenantId }, async (tx) => {
      const lock = await this.lockout.state(tx, emailHash);
      const user = await tx.prisma.user.findUnique({
        where: { tenantId_email: { tenantId, email } },
        include: {
          identities: { where: { provider: 'password' } },
          mfaFactors: { where: { confirmedAt: { not: null } } },
        },
      });
      return { lock, user };
    });
    if (found.lock.locked) throw this.lockedError(found.lock.minutesRemaining);

    // Always run argon2, even for unknown users, so timing does not reveal who has an account.
    const identity = found.user?.identities[0];
    const ok = await this.passwords.verify(identity?.passwordHash, password);
    const user = found.user;

    if (!ok || !user || user.status === 'DISABLED' || user.deletedAt) {
      const state = await withTenant(this.prisma, { tenantId }, (tx) =>
        this.lockout.recordFailure(tx, emailHash, user?.id, client.ip),
      );
      if (state.locked) throw this.lockedError(state.minutesRemaining);
      throw invalidCredentials();
    }
    if (!user.emailVerifiedAt) {
      throw new DomainError('email_not_verified', 403, 'Verify your email to continue');
    }

    if (user.mfaFactors.length > 0) {
      await withTenant(this.prisma, { tenantId }, (tx) =>
        this.lockout.recordSuccess(tx, emailHash, user.id, client.ip),
      );
      const mfa = await this.tokens.issueMfaToken(tenantId, user.id, ['pwd']);
      return {
        status: 'mfa_required',
        mfaToken: mfa.token,
        expiresAt: mfa.expiresAt.toISOString(),
      };
    }

    return withTenant(this.prisma, { tenantId, userId: user.id }, async (tx) => {
      await this.lockout.recordSuccess(tx, emailHash, user.id, client.ip);
      const tokens = await this.sessions.start(tx, user.id, ['pwd'], client);
      return { status: 'ok' as const, tokens, user: await this.me(tx, user.id) };
    });
  }

  async refresh(tenantId: string, refreshToken: string): Promise<IssuedTokens> {
    const result = await withTenant(this.prisma, { tenantId }, (tx) =>
      this.sessions.rotate(tx, refreshToken),
    );
    if (!result.ok) {
      throw errors.unauthenticated(
        result.reason === 'expired'
          ? 'Your session has expired. Sign in again.'
          : 'Your session has ended. Sign in again.',
      );
    }
    return result.tokens;
  }

  async logout(tenantId: string, refreshToken: string): Promise<void> {
    await withTenant(this.prisma, { tenantId }, (tx) =>
      this.sessions.endByRefreshToken(tx, refreshToken),
    );
  }

  /** Returns the verified user's id (T13 activates the tenant when this is its owner). */
  async verifyEmail(tenantId: string, token: string): Promise<{ userId: string }> {
    return withTenant(this.prisma, { tenantId }, async (tx) => {
      const record = await this.consumeToken(tx, token, 'verify_email');
      await tx.prisma.user.update({
        where: { tenantId_id: { tenantId, id: record.userId } },
        data: { emailVerifiedAt: new Date(), status: 'ACTIVE' },
      });
      return { userId: record.userId };
    });
  }

  async resendVerification(tenantId: string, email: string): Promise<void> {
    const workspace = await this.assertTenant(tenantId);
    const pending = await withTenant(this.prisma, { tenantId }, async (tx) => {
      const user = await tx.prisma.user.findUnique({
        where: { tenantId_email: { tenantId, email } },
      });
      if (!user || user.emailVerifiedAt || user.status === 'DISABLED') return null;
      const verification = await this.createToken(
        tx,
        user.id,
        'verify_email',
        VERIFY_EMAIL_TTL_HOURS * 3600,
      );
      return { user, verification };
    });
    if (pending) {
      await this.mail.sendVerification(
        pending.user,
        workspace,
        pending.verification.token,
        pending.verification.tokenId,
      );
    }
  }

  async forgotPassword(tenantId: string, email: string): Promise<void> {
    const workspace = await this.assertTenant(tenantId);
    const found = await withTenant(this.prisma, { tenantId }, async (tx) => {
      const user = await tx.prisma.user.findUnique({
        where: { tenantId_email: { tenantId, email } },
        include: { identities: { where: { provider: 'password' } } },
      });
      if (!user || user.status === 'DISABLED' || user.identities.length === 0) return null;
      const reset = await this.createToken(
        tx,
        user.id,
        'reset_password',
        RESET_PASSWORD_TTL_MINUTES * 60,
      );
      return { user, reset };
    });
    if (found)
      await this.mail.sendPasswordReset(
        found.user,
        workspace,
        found.reset.token,
        found.reset.tokenId,
      );
  }

  async resetPassword(tenantId: string, token: string, newPassword: string): Promise<void> {
    const passwordHash = await this.passwords.hashNew(newPassword);
    await withTenant(this.prisma, { tenantId }, async (tx) => {
      const record = await this.consumeToken(tx, token, 'reset_password');
      await tx.prisma.userIdentity.updateMany({
        where: { userId: record.userId, provider: 'password' },
        data: { passwordHash },
      });
      // Proving control of the mailbox also verifies it.
      await tx.prisma.user.updateMany({
        where: { id: record.userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: new Date(), status: 'ACTIVE' },
      });
      await this.sessions.revokeAllForUser(tx, record.userId);
    });
  }

  async me(tx: TenantTransaction, userId: string): Promise<MeDto> {
    const { prisma, context } = tx;
    const user = await prisma.user.findUnique({
      where: { tenantId_id: { tenantId: context.tenantId, id: userId } },
      include: { mfaFactors: { where: { confirmedAt: { not: null } }, select: { id: true } } },
    });
    const settings = await prisma.tenantSettings.findUnique({
      where: { tenantId: context.tenantId },
    });
    if (!user || !settings || user.deletedAt) throw errors.notFound('User');
    return {
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerifiedAt !== null,
      locale: user.locale,
      timezone: user.timezone,
      theme: user.theme,
      density: user.density,
      mfaEnabled: user.mfaFactors.length > 0,
      workspace: { name: settings.name, slug: settings.slug },
    };
  }

  emailHash(email: string): Uint8Array<ArrayBuffer> {
    return new Uint8Array(emailRoutingHmac(email, this.config.EMAIL_ROUTING_PEPPER));
  }

  private async createToken(
    { prisma, context }: TenantTransaction,
    userId: string,
    purpose: 'verify_email' | 'reset_password',
    ttlSeconds: number,
  ): Promise<{ token: string; tokenId: string }> {
    const { token, hash } = newOneTimeToken();
    const record = await prisma.authToken.create({
      data: {
        tenantId: context.tenantId,
        userId,
        purpose,
        tokenHash: hash,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      },
    });
    return { token, tokenId: record.id };
  }

  private async consumeToken(
    { prisma, context }: TenantTransaction,
    token: string,
    purpose: 'verify_email' | 'reset_password',
  ) {
    const record = await prisma.authToken.findUnique({
      where: { tenantId_tokenHash: { tenantId: context.tenantId, tokenHash: sha256(token) } },
    });
    if (!record || record.purpose !== purpose || record.usedAt || record.expiresAt <= new Date()) {
      throw new DomainError('validation_failed', 400, 'This link has expired or was already used', [
        {
          field: 'token',
          code: 'invalid_token',
          message: 'This link has expired or was already used. Request a new one.',
        },
      ]);
    }
    await prisma.authToken.update({
      where: { tenantId_id: { tenantId: context.tenantId, id: record.id } },
      data: { usedAt: new Date() },
    });
    return record;
  }

  private lockedError(minutes: number): DomainError {
    return new DomainError(
      'account_locked',
      423,
      `Too many attempts. Try again in ${String(minutes)} minutes.`,
      undefined,
      {
        'retry-after': String(minutes * 60),
      },
    );
  }
}
