import { generate } from 'otplib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestApi, type TestApi } from './support.js';

let api: TestApi;
let alpha: string;
let bravo: string;
const PASSWORD = 'a sturdy passphrase 4821';

beforeAll(async () => {
  api = await startTestApi();
  alpha = await api.seedTenant('alpha');
  bravo = await api.seedTenant('bravo');
});

afterAll(async () => {
  await api.dispose();
});

type Json = Record<string, unknown>;
const now = () => Math.floor(Date.now() / 1000);

async function signIn(email: string) {
  const res = await api.app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { 'x-sm-tenant-id': alpha },
    payload: { email, password: PASSWORD },
  });
  return res.json<Json & { tokens?: { accessToken: string }; mfaToken?: string }>();
}

function authed(method: 'POST' | 'GET', url: string, token: string, payload?: Json) {
  return api.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload ? { payload } : {}),
  });
}

function challenge(mfaToken: string, body: Json, tenantId = alpha) {
  return api.app.inject({
    method: 'POST',
    url: '/auth/mfa/challenge',
    headers: { 'x-sm-tenant-id': tenantId },
    payload: { mfaToken, ...body },
  });
}

/** Enrol and confirm TOTP for a fresh user; returns the secret and recovery codes. */
async function userWithMfa(email: string) {
  await api.seedUser(alpha, email, PASSWORD);
  const access = (await signIn(email)).tokens?.accessToken ?? '';
  const enrolled = (await authed('POST', '/auth/mfa/totp/enroll', access)).json<{
    secret: string;
    factorId: string;
  }>();
  const confirmed = await authed('POST', '/auth/mfa/totp/confirm', access, {
    code: await generate({ secret: enrolled.secret }),
  });
  return {
    secret: enrolled.secret,
    factorId: enrolled.factorId,
    recoveryCodes: confirmed.json<{ recoveryCodes: string[] }>().recoveryCodes,
    access,
  };
}

describe('TOTP enrolment', () => {
  it('requires a session', async () => {
    expect(
      (await api.app.inject({ method: 'POST', url: '/auth/mfa/totp/enroll' })).statusCode,
    ).toBe(401);
  });

  it('returns an otpauth URI, stores the secret encrypted, and confirms with a valid code', async () => {
    await api.seedUser(alpha, 'enrol@alpha.test', PASSWORD);
    const access = (await signIn('enrol@alpha.test')).tokens?.accessToken ?? '';
    const res = await authed('POST', '/auth/mfa/totp/enroll', access);
    const body = res.json<{ otpauthUri: string; secret: string; factorId: string }>();
    expect(body.otpauthUri).toMatch(/^otpauth:\/\/totp\/.*enrol%40alpha\.test\?.*secret=/);

    const db = new pg.Client({ connectionString: api.db.adminUrl });
    await db.connect();
    const { rows } = await db.query<{ secret_enc: string }>(
      'SELECT secret_enc FROM mfa_factor WHERE id = $1',
      [body.factorId],
    );
    await db.end();
    expect(rows[0]?.secret_enc.startsWith('local-1:')).toBe(true);
    expect(rows[0]?.secret_enc).not.toContain(body.secret);

    expect(
      (await authed('POST', '/auth/mfa/totp/confirm', access, { code: '000000' })).statusCode,
    ).toBe(400);
    const confirmed = await authed('POST', '/auth/mfa/totp/confirm', access, {
      code: await generate({ secret: body.secret }),
    });
    expect(confirmed.statusCode).toBe(200);
    const codes = confirmed.json<{ recoveryCodes: string[] }>().recoveryCodes;
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}$/);
    expect((await authed('POST', '/auth/mfa/totp/enroll', access)).statusCode).toBe(409);
  });
});

describe('two-step sign-in', () => {
  it('asks for a second factor, then signs in with a fresh TOTP code', async () => {
    const { secret } = await userWithMfa('two@alpha.test');
    const first = await signIn('two@alpha.test');
    expect(first['status']).toBe('mfa_required');
    const mfaToken = first.mfaToken ?? '';
    // The MFA token is not an access token.
    expect((await authed('GET', '/v1/me', mfaToken)).statusCode).toBe(401);

    const next = await generate({ secret, epoch: now() + 30 });
    const res = await challenge(mfaToken, { code: next });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; user: Json; tokens: { accessToken: string } }>();
    expect(body.status).toBe('ok');
    expect(body.user['mfaEnabled']).toBe(true);
    expect((await authed('GET', '/v1/me', body.tokens.accessToken)).statusCode).toBe(200);
  });

  it('never accepts the same code twice (replay protection)', async () => {
    const { secret } = await userWithMfa('replay@alpha.test');
    const code = await generate({ secret, epoch: now() + 30 });
    expect(
      (await challenge((await signIn('replay@alpha.test')).mfaToken ?? '', { code })).statusCode,
    ).toBe(200);
    expect(
      (await challenge((await signIn('replay@alpha.test')).mfaToken ?? '', { code })).statusCode,
    ).toBe(400);
  });

  it('accepts each recovery code exactly once', async () => {
    const { recoveryCodes } = await userWithMfa('recover@alpha.test');
    const code = recoveryCodes[0] ?? '';
    expect(
      (await challenge((await signIn('recover@alpha.test')).mfaToken ?? '', { recoveryCode: code }))
        .statusCode,
    ).toBe(200);
    expect(
      (await challenge((await signIn('recover@alpha.test')).mfaToken ?? '', { recoveryCode: code }))
        .statusCode,
    ).toBe(400);
  });

  it('locks after 10 wrong codes', async () => {
    await userWithMfa('brute@alpha.test');
    const mfaToken = (await signIn('brute@alpha.test')).mfaToken ?? '';
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1)
      statuses.push((await challenge(mfaToken, { code: String(100000 + i) })).statusCode);
    expect(statuses.slice(0, 9)).toEqual(Array(9).fill(400));
    expect(statuses.slice(9)).toEqual([423, 423]);
  });

  it('rejects an MFA token presented to another workspace, or a forged one', async () => {
    const { secret } = await userWithMfa('cross@alpha.test');
    const mfaToken = (await signIn('cross@alpha.test')).mfaToken ?? '';
    const code = await generate({ secret, epoch: now() + 30 });
    expect((await challenge(mfaToken, { code }, bravo)).statusCode).toBe(401);
    expect((await challenge(`${mfaToken.slice(0, -4)}AAAA`, { code })).statusCode).toBe(401);
  });

  it('validates the challenge body', async () => {
    expect((await challenge('x'.repeat(40), { code: 'abc' })).statusCode).toBe(400);
    expect(
      (await challenge('x'.repeat(40), { code: '123456', recoveryCode: 'abcd-efgh' })).statusCode,
    ).toBe(400);
  });
});
