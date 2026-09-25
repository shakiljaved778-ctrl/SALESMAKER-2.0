import { buildFakesServer } from '@sm/testing';
import type { FastifyInstance } from 'fastify';
import { generate } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestApi, type TestApi } from './support.js';

let fakes: FastifyInstance;
let api: TestApi;
let alpha: string;
let bravo: string;
const PASSWORD = 'a sturdy passphrase 4821';
const callbackFor = (slug: string, provider = 'google') =>
  `http://${slug}.localhost:3000/auth/callback/${provider}`;

beforeAll(async () => {
  const probe = await buildFakesServer({ baseUrl: 'http://127.0.0.1', providers: {} });
  const port = new URL(await probe.listen({ port: 0, host: '127.0.0.1' })).port;
  await probe.close();
  const base = `http://127.0.0.1:${port}`;
  fakes = await buildFakesServer({
    baseUrl: base,
    providers: {
      google: { clientId: 'g-client', clientSecret: 'g-secret' },
      microsoft: { clientId: 'm-client', clientSecret: 'm-secret' },
    },
  });
  await fakes.listen({ port: Number(port), host: '127.0.0.1' });
  api = await startTestApi({
    OIDC_GOOGLE_ISSUER: `${base}/google`,
    OIDC_GOOGLE_CLIENT_ID: 'g-client',
    OIDC_GOOGLE_CLIENT_SECRET: 'g-secret',
    OIDC_MICROSOFT_ISSUER: `${base}/microsoft`,
    OIDC_MICROSOFT_CLIENT_ID: 'm-client',
    OIDC_MICROSOFT_CLIENT_SECRET: 'm-secret',
    OIDC_ALLOW_INSECURE_HTTP: 'true',
  });
  alpha = await api.seedTenant('alpha');
  bravo = await api.seedTenant('bravo');
  await api.seedUser(alpha, 'amira@alpha.test', PASSWORD);
});

afterAll(async () => {
  await api.dispose();
  await fakes.close();
});

type Json = Record<string, unknown>;

/** Runs the browser part of the flow against the fake IdP and returns what the BFF would post. */
async function authorize(options: {
  provider?: 'google' | 'microsoft';
  slug?: string;
  email: string;
  unverified?: boolean;
}) {
  const provider = options.provider ?? 'google';
  const redirectUri = callbackFor(options.slug ?? 'alpha', provider);
  const start = await api.app.inject({
    method: 'POST',
    url: `/auth/oidc/${provider}/start`,
    payload: { redirectUri },
  });
  expect(start.statusCode).toBe(200);
  const { authorizationUrl, state, nonce, codeVerifier } = start.json<{
    authorizationUrl: string;
    state: string;
    nonce: string;
    codeVerifier: string;
  }>();
  const url = new URL(authorizationUrl);
  url.searchParams.set('fake_email', options.email);
  url.searchParams.set('fake_name', 'Amira Haddad');
  if (options.unverified) url.searchParams.set('fake_unverified', '1');
  const res = await fetch(url, { redirect: 'manual' });
  return {
    callbackUrl: res.headers.get('location') ?? '',
    redirectUri,
    state,
    nonce,
    codeVerifier,
  };
}

function callback(tenantId: string, body: Json, provider = 'google') {
  return api.app.inject({
    method: 'POST',
    url: `/auth/oidc/${provider}/callback`,
    headers: { 'x-sm-tenant-id': tenantId },
    payload: body,
  });
}

describe('POST /auth/oidc/{provider}/start', () => {
  it('returns a PKCE authorization URL for an allowed redirect URI', async () => {
    const res = await api.app.inject({
      method: 'POST',
      url: '/auth/oidc/google/start',
      payload: { redirectUri: callbackFor('alpha') },
    });
    const url = new URL(res.json<{ authorizationUrl: string }>().authorizationUrl);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('client_id')).toBe('g-client');
  });

  it('refuses redirect URIs that are not ours (no open redirect) and unknown providers', async () => {
    for (const redirectUri of [
      'https://evil.test/auth/callback/google',
      'http://alpha.localhost:3000/elsewhere',
      'http://alpha.localhost:3000/auth/callback/microsoft',
    ]) {
      const res = await api.app.inject({
        method: 'POST',
        url: '/auth/oidc/google/start',
        payload: { redirectUri },
      });
      expect(res.statusCode, redirectUri).toBe(400);
    }
    expect(
      (
        await api.app.inject({
          method: 'POST',
          url: '/auth/oidc/github/start',
          payload: { redirectUri: callbackFor('alpha') },
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe('POST /auth/oidc/{provider}/callback', () => {
  it('links a verified identity to the existing user with that email and signs in', async () => {
    const res = await callback(alpha, await authorize({ email: 'amira@alpha.test' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', user: { email: 'amira@alpha.test' } });
    // The link persists: signing in again works the same way.
    expect((await callback(alpha, await authorize({ email: 'amira@alpha.test' }))).statusCode).toBe(
      200,
    );
  });

  it('works for Microsoft too, keyed by oid', async () => {
    const res = await callback(
      alpha,
      await authorize({ provider: 'microsoft', email: 'amira@alpha.test' }),
      'microsoft',
    );
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  it('never auto-joins: an unknown email gets 403', async () => {
    const res = await callback(alpha, await authorize({ email: 'stranger@alpha.test' }));
    expect(res.statusCode).toBe(403);
  });

  it('does not link an email the provider has not verified', async () => {
    await api.seedUser(alpha, 'careful@alpha.test', PASSWORD);
    const res = await callback(
      alpha,
      await authorize({ email: 'careful@alpha.test', unverified: true }),
    );
    expect(res.statusCode).toBe(403);
  });

  it('keeps workspaces apart: the same identity has no account in another workspace', async () => {
    const res = await callback(
      bravo,
      await authorize({ slug: 'bravo', email: 'amira@alpha.test' }),
    );
    expect(res.statusCode).toBe(403);
  });

  it('refuses a callback whose redirect URI belongs to another workspace', async () => {
    const res = await callback(
      alpha,
      await authorize({ slug: 'bravo', email: 'amira@alpha.test' }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('rejects a tampered state', async () => {
    const flow = await authorize({ email: 'amira@alpha.test' });
    const res = await callback(alpha, { ...flow, state: `${flow.state}x` });
    expect(res.statusCode).toBe(401);
  });

  it('still asks for the second factor when the user has TOTP on', async () => {
    await api.seedUser(alpha, 'secure@alpha.test', PASSWORD);
    const login = await api.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'x-sm-tenant-id': alpha },
      payload: { email: 'secure@alpha.test', password: PASSWORD },
    });
    const access = login.json<{ tokens: { accessToken: string } }>().tokens.accessToken;
    const auth = { authorization: `Bearer ${access}` };
    const { secret } = (
      await api.app.inject({ method: 'POST', url: '/auth/mfa/totp/enroll', headers: auth })
    ).json<{ secret: string }>();
    await api.app.inject({
      method: 'POST',
      url: '/auth/mfa/totp/confirm',
      headers: auth,
      payload: { code: await generate({ secret }) },
    });

    const res = await callback(alpha, await authorize({ email: 'secure@alpha.test' }));
    expect(res.json()).toMatchObject({ status: 'mfa_required' });
  });
});
