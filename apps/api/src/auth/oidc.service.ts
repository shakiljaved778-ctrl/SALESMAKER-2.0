import { Inject, Injectable } from '@nestjs/common';
import { withTenant, type CellPrisma } from '@sm/db';
import type { OidcIdentity, OidcProvider, OidcProviderId } from '@sm/integrations';
import { DomainError, errors } from '@sm/server-kit';
import type { Logger } from 'pino';

import type { ApiConfig } from '../config.js';
import { CONFIG, LOGGER, OIDC_PROVIDERS, PRISMA } from '../tokens.js';
import { AuthService, type ClientInfo, type LoginResult } from './auth.service.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';

export type OidcProviders = Partial<Record<OidcProviderId, OidcProvider>>;

const noAccount = () =>
  new DomainError(
    'forbidden',
    403,
    "There's no account for this email in this workspace. Ask your admin for an invitation.",
  );

@Injectable()
export class OidcService {
  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    @Inject(OIDC_PROVIDERS) private readonly providers: OidcProviders,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
  ) {}

  provider(id: OidcProviderId): OidcProvider {
    const provider = this.providers[id];
    if (!provider) throw errors.notFound('Sign-in provider');
    return provider;
  }

  /**
   * Redirect URIs are ours only (no open redirect): a workspace callback
   * `{scheme}://{slug}.{base}/auth/callback/{provider}` or the signup callback on the apex.
   */
  assertRedirectUri(provider: OidcProviderId, redirectUri: string, slug?: string): void {
    const { WEB_URL_SCHEME: scheme, WEB_BASE_DOMAIN: base } = this.config;
    const allowed = slug
      ? [`${scheme}://${slug}.${base}/auth/callback/${provider}`]
      : [
          `${scheme}://${base}/signup/callback/${provider}`,
          ...(this.workspaceCallback(provider, redirectUri) ? [redirectUri] : []),
        ];
    if (!allowed.includes(redirectUri)) {
      throw errors.validation([
        {
          field: 'redirectUri',
          code: 'not_allowed',
          message: 'This redirect address is not allowed',
        },
      ]);
    }
  }

  async start(provider: OidcProviderId, redirectUri: string) {
    this.assertRedirectUri(provider, redirectUri);
    const request = await this.provider(provider).beginSignIn(redirectUri);
    return {
      authorizationUrl: request.url,
      state: request.state,
      nonce: request.nonce,
      codeVerifier: request.codeVerifier,
    };
  }

  async identify(
    provider: OidcProviderId,
    input: {
      callbackUrl: string;
      redirectUri: string;
      state: string;
      nonce: string;
      codeVerifier: string;
    },
  ): Promise<OidcIdentity> {
    try {
      return await this.provider(provider).completeSignIn(new URL(input.callbackUrl), input);
    } catch (err) {
      if (err instanceof DomainError) throw err;
      this.logger.warn({ err, provider }, 'OIDC sign-in failed');
      throw errors.unauthenticated("We couldn't sign you in with that account. Try again.");
    }
  }

  /**
   * Sign in to a workspace (§6.1): by a previously linked identity, or by linking to an existing
   * user whose email the provider has verified. Never creates users here (no auto-join).
   */
  async signIn(
    tenantId: string,
    provider: OidcProviderId,
    input: Parameters<OidcService['identify']>[1],
    client: ClientInfo,
  ): Promise<LoginResult> {
    const workspace = await this.auth.assertTenant(tenantId);
    this.assertRedirectUri(provider, input.redirectUri, workspace.slug);
    const identity = await this.identify(provider, input);

    const user = await withTenant(this.prisma, { tenantId }, async ({ prisma }) => {
      const linked = await prisma.userIdentity.findUnique({
        where: { tenantId_provider_subject: { tenantId, provider, subject: identity.subject } },
        include: { user: { include: { mfaFactors: { where: { confirmedAt: { not: null } } } } } },
      });
      if (linked) return linked.user;
      if (!identity.emailVerified || !identity.email) return null;
      const existing = await prisma.user.findUnique({
        where: { tenantId_email: { tenantId, email: identity.email } },
        include: { mfaFactors: { where: { confirmedAt: { not: null } } } },
      });
      if (!existing || existing.status === 'DISABLED' || existing.deletedAt) return null;
      await prisma.userIdentity.create({
        data: { tenantId, userId: existing.id, provider, subject: identity.subject },
      });
      if (!existing.emailVerifiedAt) {
        // The provider verified the mailbox, which is what our own link would have proved.
        await prisma.user.update({
          where: { tenantId_id: { tenantId, id: existing.id } },
          data: { emailVerifiedAt: new Date(), status: 'ACTIVE' },
        });
      }
      return existing;
    });
    if (!user || user.status === 'DISABLED' || user.deletedAt) throw noAccount();

    if (user.mfaFactors.length > 0) {
      const mfa = await this.tokens.issueMfaToken(tenantId, user.id, [provider]);
      return {
        status: 'mfa_required',
        mfaToken: mfa.token,
        expiresAt: mfa.expiresAt.toISOString(),
      };
    }
    return withTenant(this.prisma, { tenantId, userId: user.id }, async (tx) => ({
      status: 'ok' as const,
      tokens: await this.sessions.start(tx, user.id, [provider], client),
      user: await this.auth.me(tx, user.id),
    }));
  }

  private workspaceCallback(provider: OidcProviderId, uri: string): boolean {
    const { WEB_URL_SCHEME: scheme, WEB_BASE_DOMAIN: base } = this.config;
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
      `^${scheme}://[a-z0-9]+(?:-[a-z0-9]+)*\\.${escaped}/auth/callback/${provider}$`,
    ).test(uri);
  }
}
