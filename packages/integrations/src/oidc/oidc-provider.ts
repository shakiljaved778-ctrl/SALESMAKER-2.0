/** Social / enterprise sign-in providers (§6.1). Implemented with openid-client in the API. */
export type OidcProviderId = 'google' | 'microsoft';

export interface OidcIdentity {
  provider: OidcProviderId;
  /** Stable subject identifier from the ID token (`sub`, or `oid` for Microsoft). */
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

export interface OidcAuthorizationRequest {
  url: string;
  /** Opaque values the caller stores (httpOnly cookie) and hands back to completeSignIn. */
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface OidcProvider {
  readonly id: OidcProviderId;
  beginSignIn(redirectUri: string): Promise<OidcAuthorizationRequest>;
  completeSignIn(
    callbackUrl: URL,
    expected: { state: string; nonce: string; codeVerifier: string; redirectUri: string },
  ): Promise<OidcIdentity>;
}
