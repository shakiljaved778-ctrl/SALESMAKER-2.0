import { Inject, Injectable } from '@nestjs/common';
import { withTenant, type CellPrisma, type TenantTransaction } from '@sm/db';
import type { OidcProviderId } from '@sm/integrations';
import {
  ControlPlaneUnavailableError,
  DomainError,
  emailRoutingHmac,
  errors,
  type ControlPlane,
  type TokenBucketRateLimiter,
} from '@sm/server-kit';
import type { Logger } from 'pino';

import { AuthEmailService } from '../auth/auth-email.service.js';
import { AuthService, type ClientInfo, type LoginResult } from '../auth/auth.service.js';
import { OidcService } from '../auth/oidc.service.js';
import { PasswordService } from '../auth/password.service.js';
import { SessionService } from '../auth/session.service.js';
import { provisionDefaultProfiles } from '../permissions/default-profiles.js';
import type { ApiConfig } from '../config.js';
import { CONFIG, CONTROL_PLANE, LOGGER, PRISMA, RATE_LIMITER } from '../tokens.js';

export interface OrganisationInput {
  orgName: string;
  slug: string;
  currency: string;
  timezone: string;
  locale?: string | undefined;
}

const unavailable = () =>
  new DomainError(
    'service_unavailable',
    503,
    "We couldn't reach our sign-up service. Nothing was created; try again in a moment.",
  );

/**
 * Self-serve signup (§7.20a, §3.4). The control plane reserves the slug (idempotently, keyed by
 * the caller's Idempotency-Key); the cell then provisions settings and the owner in one tenant
 * transaction. If provisioning fails, the reservation is released (compensation). A retry with
 * the same key finds the provisioned tenant and replays the result.
 */
@Injectable()
export class SignupService {
  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    @Inject(CONTROL_PLANE) private readonly controlPlane: ControlPlane,
    @Inject(RATE_LIMITER) private readonly limiter: TokenBucketRateLimiter,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly auth: AuthService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly oidc: OidcService,
    private readonly mail: AuthEmailService,
  ) {}

  async signup(
    idempotencyKey: string,
    input: OrganisationInput & { name: string; email: string; password: string },
    client: ClientInfo,
  ) {
    await this.checkRate(client);
    await this.assertOrganisation(input);
    const passwordHash = await this.passwords.hashNew(input.password);
    const reserved = await this.reserve(idempotencyKey, input, input.email);

    const outcome = await this.provision(reserved.tenantId, input, async (tx) => {
      const { userId, verification } = await this.auth.createPasswordUser(tx, {
        email: input.email,
        name: input.name,
        passwordHash,
        locale: input.locale,
      });
      return { userId, verification };
    });
    if (outcome.created) {
      await this.mail.sendVerification(
        { email: input.email, name: input.name, locale: input.locale ?? null },
        { name: input.orgName, slug: reserved.slug },
        outcome.created.verification.token,
        outcome.created.verification.tokenId,
      );
    }
    return {
      tenantId: reserved.tenantId,
      slug: reserved.slug,
      status: 'PENDING' as const,
      verificationSentTo: input.email,
    };
  }

  /** Signup with Google/Microsoft: the provider verified the email, so the tenant goes live now. */
  async signupWithOidc(
    idempotencyKey: string,
    provider: OidcProviderId,
    input: OrganisationInput & {
      callbackUrl: string;
      redirectUri: string;
      state: string;
      nonce: string;
      codeVerifier: string;
    },
    client: ClientInfo,
  ): Promise<{ tenantId: string; slug: string; login: LoginResult }> {
    await this.checkRate(client);
    await this.assertOrganisation(input);
    const expected = `${this.config.WEB_URL_SCHEME}://${this.config.WEB_BASE_DOMAIN}/signup/callback/${provider}`;
    if (input.redirectUri !== expected) {
      throw errors.validation([
        {
          field: 'redirectUri',
          code: 'not_allowed',
          message: 'This redirect address is not allowed',
        },
      ]);
    }
    const identity = await this.oidc.identify(provider, input);
    if (!identity.emailVerified || !identity.email) {
      throw errors.validation([
        {
          field: 'email',
          code: 'unverified',
          message: 'Your provider has not verified this email address',
        },
      ]);
    }
    const reserved = await this.reserve(idempotencyKey, input, identity.email);

    const outcome = await this.provision(reserved.tenantId, input, async (tx) => {
      const { prisma, context } = tx;
      const user = await prisma.user.create({
        data: {
          tenantId: context.tenantId,
          email: identity.email,
          name: identity.name,
          locale: input.locale ?? null,
          status: 'ACTIVE',
          emailVerifiedAt: new Date(),
        },
      });
      await prisma.userIdentity.create({
        data: { tenantId: context.tenantId, userId: user.id, provider, subject: identity.subject },
      });
      return { userId: user.id };
    });

    await this.activate(reserved.tenantId);
    const login = await withTenant(
      this.prisma,
      { tenantId: reserved.tenantId, userId: outcome.ownerUserId },
      async (tx) => {
        await tx.prisma.tenantSettings.update({
          where: { tenantId: reserved.tenantId },
          data: { activatedAt: new Date() },
        });
        return {
          status: 'ok' as const,
          tokens: await this.sessions.start(tx, outcome.ownerUserId, [provider], client),
          user: await this.auth.me(tx, outcome.ownerUserId),
        };
      },
    );
    return { tenantId: reserved.tenantId, slug: reserved.slug, login };
  }

  /** Called when an owner verifies their email: activate in the control plane, idempotently. */
  async activate(tenantId: string): Promise<void> {
    try {
      await this.controlPlane.activateTenant(tenantId);
    } catch (err) {
      if (err instanceof ControlPlaneUnavailableError) throw unavailable();
      throw err;
    }
  }

  private async checkRate(client: ClientInfo): Promise<void> {
    const perHour = this.config.SIGNUP_RATE_PER_HOUR;
    const result = await this.limiter
      .consume(`signup:ip:${client.ip ?? 'unknown'}`, {
        capacity: perHour,
        refillPerSecond: perHour / 3600,
      })
      .catch(() => ({ allowed: true }));
    if (!result.allowed)
      throw new DomainError(
        'rate_limited',
        429,
        'Too many sign-ups from this network. Try again later.',
      );
  }

  private async assertOrganisation(input: OrganisationInput): Promise<void> {
    const problems: { field: string; code: string; message: string }[] = [];
    try {
      new Intl.DateTimeFormat('en', { timeZone: input.timezone });
    } catch {
      problems.push({
        field: 'timezone',
        code: 'unknown',
        message: 'Choose a time zone from the list',
      });
    }
    const currency = await this.prisma.currency.findUnique({ where: { code: input.currency } });
    if (!currency)
      problems.push({
        field: 'currency',
        code: 'unknown',
        message: 'Choose a currency from the list',
      });
    if (problems.length) throw errors.validation(problems);
  }

  private async reserve(idempotencyKey: string, input: OrganisationInput, ownerEmail: string) {
    try {
      return await this.controlPlane.reserveTenant(`signup:${idempotencyKey}`, {
        slug: input.slug,
        name: input.orgName,
        ownerEmailHmac: emailRoutingHmac(ownerEmail, this.config.EMAIL_ROUTING_PEPPER).toString(
          'base64url',
        ),
      });
    } catch (err) {
      if (err instanceof ControlPlaneUnavailableError) throw unavailable();
      throw err;
    }
  }

  /**
   * Create settings and the owner in one tenant transaction. If the tenant already exists (a
   * retry of the same signup), nothing is created and the existing owner is returned.
   */
  private async provision<T extends { userId: string }>(
    tenantId: string,
    input: OrganisationInput,
    createOwner: (tx: TenantTransaction) => Promise<T>,
  ): Promise<{ ownerUserId: string; created: T | null }> {
    try {
      return await withTenant(this.prisma, { tenantId }, async (tx) => {
        const existing = await tx.prisma.tenantSettings.findUnique({ where: { tenantId } });
        if (existing?.ownerUserId) return { ownerUserId: existing.ownerUserId, created: null };
        await tx.prisma.tenantSettings.create({
          data: {
            tenantId,
            name: input.orgName,
            slug: input.slug,
            region: this.config.CELL_ID,
            corporateCurrency: input.currency,
            defaultTimezone: input.timezone,
            defaultLocale: input.locale ?? 'en',
          },
        });
        const profiles = await provisionDefaultProfiles(tx, tenantId, input.locale ?? 'en');
        const created = await createOwner(tx);
        await tx.prisma.user.update({
          where: { tenantId_id: { tenantId, id: created.userId } },
          data: { profileId: profiles.system_administrator },
        });
        await tx.prisma.tenantSettings.update({
          where: { tenantId },
          data: { ownerUserId: created.userId },
        });
        return { ownerUserId: created.userId, created };
      });
    } catch (err) {
      await this.controlPlane.releaseTenant(tenantId).catch((releaseError: unknown) => {
        this.logger.error(
          { err: releaseError, tenantId },
          'could not release the reservation after a failed signup',
        );
      });
      throw err;
    }
  }
}
