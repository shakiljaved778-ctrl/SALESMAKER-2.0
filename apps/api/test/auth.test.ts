import { SignJWT, importPKCS8 } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { JWT_KEYS, startTestApi, type TestApi } from './support.js';

let api: TestApi;
let alpha: string;
let bravo: string;
const PASSWORD = 'a sturdy passphrase 4821';

beforeAll(async () => {
  api = await startTestApi();
  alpha = await api.seedTenant('alpha');
  bravo = await api.seedTenant('bravo');
  await api.seedUser(alpha, 'ana@alpha.test', PASSWORD);
  await api.seedUser(bravo, 'ben@bravo.test', PASSWORD);
});

afterAll(async () => {
  await api.dispose();
});

type Json = Record<string, unknown>;

function post(url: string, tenantId: string | undefined, payload: Json) {
  return api.app.inject({
    method: 'POST',
    url,
    payload,
    headers: tenantId ? { 'x-sm-tenant-id': tenantId } : {},
  });
}

async function login(tenantId: string, email: string, password = PASSWORD) {
  const res = await post('/auth/login', tenantId, { email, password });
  return res.json<{
    status: string;
    tokens: { accessToken: string; refreshToken: string };
    user: Json;
  }>();
}

function tokenFromEmail(to: string): string {
  const text = api.email.lastTo(to)?.text ?? '';
  const token = /token=([A-Za-z0-9_%-]+)/.exec(text)?.[1];
  if (!token) throw new Error(`no token emailed to ${to}`);
  return decodeURIComponent(token);
}

describe('POST /auth/login', () => {
  it('signs a verified user in and returns tokens and the user', async () => {
    const res = await post('/auth/login', alpha, { email: 'ana@alpha.test', password: PASSWORD });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; tokens: Json; user: Json }>();
    expect(body.status).toBe('ok');
    expect(body.tokens['refreshToken']).toMatch(/^smrt_/);
    expect(body.user).toMatchObject({
      email: 'ana@alpha.test',
      tenantId: alpha,
      workspace: { slug: 'alpha' },
      mfaEnabled: false,
    });
  });

  it('gives the same 401 for a wrong password and for an unknown address', async () => {
    const wrong = await post('/auth/login', alpha, {
      email: 'ana@alpha.test',
      password: 'not the password!!',
    });
    const unknown = await post('/auth/login', alpha, {
      email: 'nobody@alpha.test',
      password: 'not the password!!',
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json<Json>()['detail']).toBe(unknown.json<Json>()['detail']);
  });

  it('keeps tenants apart: a user of one workspace cannot sign in to another', async () => {
    const res = await post('/auth/login', bravo, { email: 'ana@alpha.test', password: PASSWORD });
    expect(res.statusCode).toBe(401);
  });

  it('validates input and the workspace header', async () => {
    expect(
      (await post('/auth/login', undefined, { email: 'ana@alpha.test', password: PASSWORD }))
        .statusCode,
    ).toBe(400);
    expect(
      (await post('/auth/login', alpha, { email: 'not-an-email', password: PASSWORD })).statusCode,
    ).toBe(400);
    const elsewhere = await post('/auth/login', '01920000-0000-7000-8000-00000000dead', {
      email: 'ana@alpha.test',
      password: PASSWORD,
    });
    expect(elsewhere.statusCode).toBe(404);
  });

  it('asks an unverified user to verify, but only after the password is right', async () => {
    await api.seedUser(alpha, 'unverified@alpha.test', PASSWORD, { verified: false });
    expect(
      (
        await post('/auth/login', alpha, {
          email: 'unverified@alpha.test',
          password: 'wrong password 123',
        })
      ).statusCode,
    ).toBe(401);
    const res = await post('/auth/login', alpha, {
      email: 'unverified@alpha.test',
      password: PASSWORD,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'email_not_verified' });
  });

  it('locks an address after 10 failures in 15 minutes, even for the right password (§6.1)', async () => {
    await api.seedUser(alpha, 'target@alpha.test', PASSWORD);
    const statuses: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      statuses.push(
        (
          await post('/auth/login', alpha, {
            email: 'target@alpha.test',
            password: `guess number ${String(i)}`,
          })
        ).statusCode,
      );
    }
    expect(statuses.slice(0, 9)).toEqual(Array(9).fill(401));
    expect(statuses[9]).toBe(423);
    const correct = await post('/auth/login', alpha, {
      email: 'target@alpha.test',
      password: PASSWORD,
    });
    expect(correct.statusCode).toBe(423);
    expect(correct.headers['retry-after']).toBe('900');
    expect(correct.json()).toMatchObject({ code: 'account_locked' });
    // Another user in the same workspace is unaffected.
    expect(
      (await post('/auth/login', alpha, { email: 'ana@alpha.test', password: PASSWORD }))
        .statusCode,
    ).toBe(200);
  });
});

describe('POST /auth/refresh and /auth/logout (§6.1)', () => {
  it('rotates the refresh token', async () => {
    const { tokens } = await login(alpha, 'ana@alpha.test');
    const res = await post('/auth/refresh', alpha, { refreshToken: tokens.refreshToken });
    expect(res.statusCode).toBe(200);
    const next = res.json<{ refreshToken: string; accessToken: string }>();
    expect(next.refreshToken).not.toBe(tokens.refreshToken);
    const me = await api.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${next.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it('revokes the whole session when a used refresh token is presented again (reuse detection)', async () => {
    const { tokens } = await login(alpha, 'ana@alpha.test');
    const rotated = (
      await post('/auth/refresh', alpha, { refreshToken: tokens.refreshToken })
    ).json<{ refreshToken: string }>();
    const replay = await post('/auth/refresh', alpha, { refreshToken: tokens.refreshToken });
    expect(replay.statusCode).toBe(401);
    // The legitimate newer token died with the family.
    expect(
      (await post('/auth/refresh', alpha, { refreshToken: rotated.refreshToken })).statusCode,
    ).toBe(401);
  });

  it('does not accept one workspace’s refresh token in another (RLS)', async () => {
    const { tokens } = await login(alpha, 'ana@alpha.test');
    expect(
      (await post('/auth/refresh', bravo, { refreshToken: tokens.refreshToken })).statusCode,
    ).toBe(401);
    expect(
      (await post('/auth/refresh', alpha, { refreshToken: tokens.refreshToken })).statusCode,
    ).toBe(200);
  });

  it('ends the session on logout, idempotently', async () => {
    const { tokens } = await login(alpha, 'ana@alpha.test');
    expect(
      (await post('/auth/logout', alpha, { refreshToken: tokens.refreshToken })).statusCode,
    ).toBe(204);
    expect(
      (await post('/auth/logout', alpha, { refreshToken: tokens.refreshToken })).statusCode,
    ).toBe(204);
    expect(
      (await post('/auth/refresh', alpha, { refreshToken: tokens.refreshToken })).statusCode,
    ).toBe(401);
  });

  it('rejects malformed refresh tokens as a validation error', async () => {
    expect((await post('/auth/refresh', alpha, { refreshToken: 'short' })).statusCode).toBe(400);
  });
});

describe('email verification', () => {
  it('verifies with the emailed link once, then allows sign-in', async () => {
    await api.seedUser(alpha, 'newbie@alpha.test', PASSWORD, { verified: false });
    expect(
      (await post('/auth/verify-email/resend', alpha, { email: 'newbie@alpha.test' })).statusCode,
    ).toBe(202);
    const token = tokenFromEmail('newbie@alpha.test');
    expect(api.email.lastTo('newbie@alpha.test')?.text).toContain(
      'http://alpha.localhost:3000/verify-email?token=',
    );
    expect((await post('/auth/verify-email', alpha, { token })).statusCode).toBe(200);
    expect((await post('/auth/verify-email', alpha, { token })).statusCode).toBe(400);
    expect((await login(alpha, 'newbie@alpha.test')).status).toBe('ok');
  });

  it('answers 202 without sending anything for unknown or already-verified addresses', async () => {
    const before = api.email.outbox.length;
    expect(
      (await post('/auth/verify-email/resend', alpha, { email: 'ghost@alpha.test' })).statusCode,
    ).toBe(202);
    expect(
      (await post('/auth/verify-email/resend', alpha, { email: 'ana@alpha.test' })).statusCode,
    ).toBe(202);
    expect(api.email.outbox.length).toBe(before);
  });

  it('does not accept a token in another workspace', async () => {
    await api.seedUser(alpha, 'crosser@alpha.test', PASSWORD, { verified: false });
    await post('/auth/verify-email/resend', alpha, { email: 'crosser@alpha.test' });
    const token = tokenFromEmail('crosser@alpha.test');
    expect((await post('/auth/verify-email', bravo, { token })).statusCode).toBe(400);
  });
});

describe('password reset', () => {
  it('resets with the emailed token, rejects breached passwords, and signs out every session', async () => {
    await api.seedUser(alpha, 'forgetful@alpha.test', PASSWORD);
    const before = await login(alpha, 'forgetful@alpha.test');
    expect(
      (await post('/auth/password/forgot', alpha, { email: 'forgetful@alpha.test' })).statusCode,
    ).toBe(202);
    const token = tokenFromEmail('forgetful@alpha.test');

    const breached = await post('/auth/password/reset', alpha, {
      token,
      newPassword: 'password1234',
    });
    expect(breached.statusCode).toBe(400);
    expect(breached.json<{ errors: Json[] }>().errors[0]).toMatchObject({
      field: 'password',
      code: 'breached',
    });
    const tooShort = await post('/auth/password/reset', alpha, { token, newPassword: 'short' });
    expect(tooShort.statusCode).toBe(400);

    expect(
      (
        await post('/auth/password/reset', alpha, {
          token,
          newPassword: 'a brand new passphrase 77',
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await post('/auth/password/reset', alpha, { token, newPassword: 'another passphrase 88' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await post('/auth/refresh', alpha, { refreshToken: before.tokens.refreshToken })).statusCode,
    ).toBe(401);
    expect(
      (await post('/auth/login', alpha, { email: 'forgetful@alpha.test', password: PASSWORD }))
        .statusCode,
    ).toBe(401);
    expect((await login(alpha, 'forgetful@alpha.test', 'a brand new passphrase 77')).status).toBe(
      'ok',
    );
  });

  it('answers 202 for unknown addresses without sending mail', async () => {
    const before = api.email.outbox.length;
    expect(
      (await post('/auth/password/forgot', alpha, { email: 'ghost@alpha.test' })).statusCode,
    ).toBe(202);
    expect(api.email.outbox.length).toBe(before);
  });
});

describe('GET/PATCH /v1/me', () => {
  it('returns the caller, and requires a valid access token', async () => {
    const { tokens } = await login(alpha, 'ana@alpha.test');
    const ok = await api.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    expect(ok.json()).toMatchObject({
      email: 'ana@alpha.test',
      theme: 'system',
      density: 'default',
    });
    expect((await api.app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401);
    const tampered = `${tokens.accessToken.slice(0, -4)}AAAA`;
    expect(
      (
        await api.app.inject({
          method: 'GET',
          url: '/v1/me',
          headers: { authorization: `Bearer ${tampered}` },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('takes the tenant from the token, never from headers', async () => {
    const { tokens } = await login(alpha, 'ana@alpha.test');
    const res = await api.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${tokens.accessToken}`, 'x-sm-tenant-id': bravo },
    });
    expect(res.json()).toMatchObject({ tenantId: alpha, email: 'ana@alpha.test' });
  });

  it('refuses expired tokens and tokens from another cell', async () => {
    const key = await importPKCS8(JWT_KEYS.privatePem, 'EdDSA');
    const base = { tid: alpha, sid: '01920000-0000-7000-8000-000000000001', amr: ['pwd'] };
    const expired = await new SignJWT(base)
      .setProtectedHeader({ alg: 'EdDSA', kid: 'test-1', typ: 'sm-access+jwt' })
      .setIssuer('eu-central-1')
      .setAudience('sm-api')
      .setSubject('01920000-0000-7000-8000-000000000002')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(key);
    const otherCell = await new SignJWT(base)
      .setProtectedHeader({ alg: 'EdDSA', kid: 'test-1', typ: 'sm-access+jwt' })
      .setIssuer('me-central-1')
      .setAudience('sm-api')
      .setSubject('01920000-0000-7000-8000-000000000002')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key);
    for (const token of [expired, otherCell]) {
      expect(
        (
          await api.app.inject({
            method: 'GET',
            url: '/v1/me',
            headers: { authorization: `Bearer ${token}` },
          })
        ).statusCode,
      ).toBe(401);
    }
  });

  it('updates display preferences and rejects unknown fields', async () => {
    const { tokens } = await login(alpha, 'ana@alpha.test');
    const headers = { authorization: `Bearer ${tokens.accessToken}` };
    const res = await api.app.inject({
      method: 'PATCH',
      url: '/v1/me/preferences',
      headers,
      payload: { theme: 'dark', density: 'compact' },
    });
    expect(res.json()).toMatchObject({ theme: 'dark', density: 'compact' });
    expect(
      (
        await api.app.inject({
          method: 'PATCH',
          url: '/v1/me/preferences',
          headers,
          payload: { theme: 'neon' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await api.app.inject({
          method: 'PATCH',
          url: '/v1/me/preferences',
          headers,
          payload: { email: 'x@y.z' },
        })
      ).statusCode,
    ).toBe(400);
  });
});
