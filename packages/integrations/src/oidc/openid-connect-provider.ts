import * as oidc from 'openid-client';

import type {
  OidcAuthorizationRequest,
  OidcIdentity,
  OidcProvider,
  OidcProviderId,
} from './oidc-provider.js';

export interface OpenIdConnectProviderOptions {
  id: OidcProviderId;
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Plain-HTTP issuers are allowed only for the local fakes; never in production. */
  allowInsecureHttp?: boolean;
}

/**
 * Social sign-in over OpenID Connect (§6.1): authorization code + PKCE (S256) with state and
 * nonce, ID token validated by openid-client (signature via JWKS, issuer, audience, expiry,
 * nonce). The subject is `oid` for Microsoft (stable across apps) and `sub` otherwise.
 */
export class OpenIdConnectProvider implements OidcProvider {
  readonly id: OidcProviderId;
  private configuration: Promise<oidc.Configuration> | undefined;

  constructor(private readonly options: OpenIdConnectProviderOptions) {
    this.id = options.id;
  }

  async beginSignIn(redirectUri: string): Promise<OidcAuthorizationRequest> {
    const config = await this.config();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      state,
      nonce,
      prompt: 'select_account',
    });
    return { url: url.toString(), state, nonce, codeVerifier };
  }

  async completeSignIn(
    callbackUrl: URL,
    expected: { state: string; nonce: string; codeVerifier: string; redirectUri: string },
  ): Promise<OidcIdentity> {
    const config = await this.config();
    const tokens = await oidc.authorizationCodeGrant(
      config,
      callbackUrl,
      {
        pkceCodeVerifier: expected.codeVerifier,
        expectedState: expected.state,
        expectedNonce: expected.nonce,
        idTokenExpected: true,
      },
      { redirect_uri: expected.redirectUri },
    );
    const claims = tokens.claims();
    if (!claims) throw new Error('the identity provider returned no ID token');
    const email =
      typeof claims['email'] === 'string'
        ? claims['email']
        : typeof claims['preferred_username'] === 'string'
          ? claims['preferred_username']
          : '';
    const subject =
      this.id === 'microsoft' && typeof claims['oid'] === 'string' ? claims['oid'] : claims.sub;
    return {
      provider: this.id,
      subject,
      email: email.toLowerCase(),
      emailVerified: claims['email_verified'] === true,
      name: typeof claims['name'] === 'string' && claims['name'].trim() ? claims['name'] : email,
    };
  }

  private config(): Promise<oidc.Configuration> {
    this.configuration ??= oidc
      .discovery(
        new URL(this.options.issuer),
        this.options.clientId,
        undefined,
        oidc.ClientSecretPost(this.options.clientSecret),
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- opt-in for the local HTTP fakes only
        this.options.allowInsecureHttp ? { execute: [oidc.allowInsecureRequests] } : undefined,
      )
      .catch((error: unknown) => {
        this.configuration = undefined; // retry discovery on the next request
        throw error;
      });
    return this.configuration;
  }
}
