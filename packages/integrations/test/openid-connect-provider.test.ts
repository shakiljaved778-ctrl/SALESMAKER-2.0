import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OpenIdConnectProvider, type OidcAuthorizationRequest } from '../src/index.js';
import { startFakeOidcIssuer, type FakeOidcIssuer } from './fake-oidc-issuer.js';

const CLIENT_ID = 'salesmaker-test';
const REDIRECT = 'http://acme.salesmaker.localhost/auth/callback/google';

describe('OpenIdConnectProvider', () => {
  let idp: FakeOidcIssuer;
  beforeAll(async () => {
    idp = await startFakeOidcIssuer(CLIENT_ID);
  });
  afterAll(async () => {
    await idp.close();
  });

  const provider = (id: 'google' | 'microsoft') =>
    new OpenIdConnectProvider({
      id,
      issuer: idp.issuer,
      clientId: CLIENT_ID,
      clientSecret: 'shh',
      allowInsecureHttp: true,
    });

  /** Plays the browser: takes the authorization URL, "signs in" and returns the callback URL. */
  const callbackFor = (request: OidcAuthorizationRequest, claims: Record<string, unknown>) => {
    const authorize = new URL(request.url);
    const code = idp.issueCode({
      nonce: authorize.searchParams.get('nonce') ?? '',
      codeChallenge: authorize.searchParams.get('code_challenge') ?? '',
      claims,
    });
    return new URL(`${REDIRECT}?code=${code}&state=${request.state}`);
  };

  it('builds a PKCE S256 authorization request with state and nonce', async () => {
    const request = await provider('google').beginSignIn(REDIRECT);
    const url = new URL(request.url);
    expect(url.origin + url.pathname).toBe(`${idp.issuer}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'openid email profile',
      code_challenge_method: 'S256',
      state: request.state,
      nonce: request.nonce,
      prompt: 'select_account',
    });
    expect(url.searchParams.get('code_challenge')).not.toBe(request.codeVerifier);
  });

  it('completes Google sign-in with a verified, lower-cased email and the sub claim', async () => {
    const google = provider('google');
    const request = await google.beginSignIn(REDIRECT);
    const identity = await google.completeSignIn(
      callbackFor(request, {
        sub: 'g-123',
        email: 'Ada@Example.TEST',
        email_verified: true,
        name: 'Ada Lovelace',
      }),
      { ...request, redirectUri: REDIRECT },
    );
    expect(identity).toEqual({
      provider: 'google',
      subject: 'g-123',
      email: 'ada@example.test',
      emailVerified: true,
      name: 'Ada Lovelace',
    });
    const form = idp.tokenRequests.at(-1);
    expect(form?.get('client_secret')).toBe('shh'); // client_secret_post
    expect(form?.get('code_verifier')).toBe(request.codeVerifier);
  });

  it('uses the Microsoft oid and falls back to preferred_username and the email as name', async () => {
    const microsoft = provider('microsoft');
    const request = await microsoft.beginSignIn(REDIRECT);
    const identity = await microsoft.completeSignIn(
      callbackFor(request, {
        sub: 'pairwise-sub',
        oid: 'oid-456',
        preferred_username: 'Grace@Contoso.TEST',
        name: '  ',
      }),
      { ...request, redirectUri: REDIRECT },
    );
    expect(identity).toEqual({
      provider: 'microsoft',
      subject: 'oid-456',
      email: 'grace@contoso.test',
      emailVerified: false,
      name: 'Grace@Contoso.TEST',
    });
  });

  it('rejects a callback whose state does not match', async () => {
    const google = provider('google');
    const request = await google.beginSignIn(REDIRECT);
    const callback = callbackFor(request, { sub: 'x', email: 'x@y.test' });
    await expect(
      google.completeSignIn(callback, { ...request, state: 'other', redirectUri: REDIRECT }),
    ).rejects.toThrow();
  });

  it('rejects an ID token issued for a different nonce', async () => {
    const google = provider('google');
    const request = await google.beginSignIn(REDIRECT);
    const code = idp.issueCode({
      nonce: 'not-the-nonce',
      codeChallenge: new URL(request.url).searchParams.get('code_challenge') ?? '',
      claims: { sub: 'x', email: 'x@y.test' },
    });
    await expect(
      google.completeSignIn(new URL(`${REDIRECT}?code=${code}&state=${request.state}`), {
        ...request,
        redirectUri: REDIRECT,
      }),
    ).rejects.toThrow();
  });

  it('retries discovery after a failure instead of caching the error', async () => {
    const google = provider('google');
    idp.failDiscovery(1);
    await expect(google.beginSignIn(REDIRECT)).rejects.toThrow();
    const request = await google.beginSignIn(REDIRECT);
    expect(request.url.startsWith(`${idp.issuer}/authorize?`)).toBe(true);
  });
});
