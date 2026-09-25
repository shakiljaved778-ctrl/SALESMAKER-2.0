import type { FastifyInstance } from 'fastify';
import * as oidc from 'openid-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildFakesServer, fakeSubject } from '../src/index.js';

let app: FastifyInstance;
let base = '';
const clients = {
  google: { clientId: 'fake-google-client', clientSecret: 'fake-google-secret' },
  microsoft: { clientId: 'fake-microsoft-client', clientSecret: 'fake-microsoft-secret' },
};

beforeAll(async () => {
  // Bind first to learn the port, then build the real server with the right issuer URL.
  const probe = await buildFakesServer({ baseUrl: 'http://127.0.0.1', providers: {} });
  const port = new URL(await probe.listen({ port: 0, host: '127.0.0.1' })).port;
  await probe.close();
  base = `http://127.0.0.1:${port}`;
  app = await buildFakesServer({ baseUrl: base, providers: clients });
  await app.listen({ port: Number(port), host: '127.0.0.1' });
});

afterAll(async () => {
  await app.close();
});

async function codeFlow(
  provider: 'google' | 'microsoft',
  options: { verifierOverride?: string } = {},
) {
  const config = await oidc.discovery(
    new URL(`${base}/${provider}`),
    clients[provider].clientId,
    clients[provider].clientSecret,
    undefined,
    {
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- the local fakes serve plain HTTP; real issuers are HTTPS
      execute: [oidc.allowInsecureRequests],
    },
  );
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const redirectUri = 'http://pixelcraft.localhost:3000/auth/callback/google';
  const authUrl = oidc.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: 'openid email profile',
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state,
    nonce,
    fake_email: 'amira@pixelcraft.test',
    fake_name: 'Amira Haddad',
  });
  const res = await fetch(authUrl, { redirect: 'manual' });
  const callback = new URL(res.headers.get('location') ?? '');
  const tokens = await oidc.authorizationCodeGrant(config, callback, {
    pkceCodeVerifier: options.verifierOverride ?? verifier,
    expectedState: state,
    expectedNonce: nonce,
    idTokenExpected: true,
  });
  return tokens.claims();
}

describe('fake OIDC providers (openid-client end to end)', () => {
  it('completes an authorization-code + PKCE flow with a valid, nonce-bound ID token', async () => {
    const claims = await codeFlow('google');
    expect(claims).toMatchObject({
      iss: `${base}/google`,
      aud: 'fake-google-client',
      sub: fakeSubject('google', 'amira@pixelcraft.test'),
      email: 'amira@pixelcraft.test',
      email_verified: true,
      name: 'Amira Haddad',
    });
  });

  it('adds Microsoft-style oid and tid claims', async () => {
    const claims = await codeFlow('microsoft');
    expect(claims?.['oid']).toBe(fakeSubject('microsoft', 'amira@pixelcraft.test'));
    expect(claims?.['tid']).toBeDefined();
  });

  it('enforces PKCE at the token endpoint', async () => {
    await expect(
      codeFlow('google', { verifierOverride: oidc.randomPKCECodeVerifier() }),
    ).rejects.toThrow();
  });

  it('renders an escaped sign-in form when no identity is preset', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/google/authorize?client_id=fake-google-client&response_type=code&code_challenge=x&code_challenge_method=S256&redirect_uri=http://x.test/cb&login_hint=%22%3E%3Cscript%3E',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Fake Google');
    expect(res.body).not.toContain('"><script>');
  });

  it('rejects unknown clients and flows without PKCE', async () => {
    const unknown = await app.inject({
      method: 'GET',
      url: '/google/authorize?client_id=nope&response_type=code',
    });
    expect(unknown.statusCode).toBe(400);
    const noPkce = await app.inject({
      method: 'GET',
      url: '/google/authorize?client_id=fake-google-client&response_type=code&redirect_uri=http://x.test/cb',
    });
    expect(noPkce.statusCode).toBe(400);
  });
});
