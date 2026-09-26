import { withTenant, type CellPrisma } from '@sm/db';
import { generate } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PRISMA } from '../src/tokens.js';
import { startTestApi, type TestApi } from './support.js';

const PASSWORD = 'a sturdy passphrase 4821';
const NEW_PASSWORD = 'another sturdy passphrase 9265';
let api: TestApi;
let prisma: CellPrisma;
let tenantId = '';
type Json = Record<string, unknown>;
const now = () => Math.floor(Date.now() / 1000);

async function signIn(email: string, password = PASSWORD) {
  return api.app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { 'x-sm-tenant-id': tenantId },
    payload: { email, password },
  });
}
const tokenOf = async (email: string, password = PASSWORD) =>
  (await signIn(email, password)).json<{ tokens: { accessToken: string } }>().tokens.accessToken;
const call = (method: 'GET' | 'POST' | 'PATCH', url: string, token: string, payload?: Json) =>
  api.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload ? { payload } : {}),
  });

beforeAll(async () => {
  api = await startTestApi();
  prisma = api.app.get<symbol, CellPrisma>(PRISMA);
  tenantId = await api.seedTenant('me-settings');
});

afterAll(async () => {
  await api.dispose();
});

describe('PATCH /v1/me/profile', () => {
  it('changes the caller’s own name, title and phone, and /v1/me shows them', async () => {
    await api.seedUser(tenantId, 'profile@me.test', PASSWORD);
    const token = await tokenOf('profile@me.test');
    const res = await call('PATCH', '/v1/me/profile', token, {
      name: 'Pat Profile',
      title: 'Account Executive',
      phone: '+974 5555 0100',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      name: 'Pat Profile',
      title: 'Account Executive',
      phone: '+974 5555 0100',
    });
    const me = await call('GET', '/v1/me', token);
    expect(me.json()).toMatchObject({ title: 'Account Executive' });
    const cleared = await call('PATCH', '/v1/me/profile', token, { title: null });
    expect(cleared.json()).toMatchObject({ title: null, name: 'Pat Profile' });
  });

  it('validates input and needs a session', async () => {
    await api.seedUser(tenantId, 'profile2@me.test', PASSWORD);
    const token = await tokenOf('profile2@me.test');
    expect((await call('PATCH', '/v1/me/profile', token, { name: '' })).statusCode).toBe(400);
    expect((await call('PATCH', '/v1/me/profile', token, { email: 'x@y.test' })).statusCode).toBe(
      400,
    ); // not a field you can change here
    expect(
      (await api.app.inject({ method: 'PATCH', url: '/v1/me/profile', payload: {} })).statusCode,
    ).toBe(401);
  });
});

describe('POST /v1/me/password', () => {
  it('changes the password and signs every other session out, keeping this one', async () => {
    await api.seedUser(tenantId, 'pw@me.test', PASSWORD);
    const here = await tokenOf('pw@me.test');
    const elsewhere = await tokenOf('pw@me.test');
    const res = await call('POST', '/v1/me/password', here, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(res.statusCode).toBe(204);
    expect((await call('GET', '/v1/me', elsewhere)).statusCode).toBe(401);
    expect((await call('GET', '/v1/me', here)).statusCode).toBe(200);
    expect((await signIn('pw@me.test')).statusCode).toBe(401);
    expect((await signIn('pw@me.test', NEW_PASSWORD)).statusCode).toBe(200);
    const audited = await withTenant(prisma, { tenantId }, (tx) =>
      tx.prisma.auditLog.count({ where: { action: 'user.password_changed' } }),
    );
    expect(audited).toBe(1);
  });

  it('refuses a wrong current password and a too-short new one', async () => {
    await api.seedUser(tenantId, 'pw2@me.test', PASSWORD);
    const token = await tokenOf('pw2@me.test');
    const wrong = await call('POST', '/v1/me/password', token, {
      currentPassword: 'not my password at all',
      newPassword: NEW_PASSWORD,
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json<{ errors: { field: string }[] }>().errors[0]?.field).toBe('currentPassword');
    const short = await call('POST', '/v1/me/password', token, {
      currentPassword: PASSWORD,
      newPassword: 'short',
    });
    expect(short.statusCode).toBe(400);
    expect((await signIn('pw2@me.test')).statusCode).toBe(200); // unchanged
  });

  it('has nothing to change for a user without a password (Google/Microsoft only)', async () => {
    const userId = await api.seedUser(tenantId, 'sso@me.test', PASSWORD);
    const token = await tokenOf('sso@me.test');
    await withTenant(prisma, { tenantId }, (tx) =>
      tx.prisma.userIdentity.deleteMany({ where: { userId, provider: 'password' } }),
    );
    const res = await call('POST', '/v1/me/password', token, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('two-step verification: disable and new recovery codes', () => {
  async function withMfa(email: string) {
    await api.seedUser(tenantId, email, PASSWORD);
    const token = await tokenOf(email);
    const { secret } = (await call('POST', '/auth/mfa/totp/enroll', token)).json<{
      secret: string;
    }>();
    const confirmed = await call('POST', '/auth/mfa/totp/confirm', token, {
      code: await generate({ secret }),
    });
    return {
      token,
      secret,
      recoveryCodes: confirmed.json<{ recoveryCodes: string[] }>().recoveryCodes,
    };
  }

  it('replaces the recovery codes with a current code; the old ones stop working', async () => {
    const { token, secret, recoveryCodes } = await withMfa('codes@me.test');
    const res = await call('POST', '/v1/me/mfa/recovery-codes', token, {
      code: await generate({ secret, epoch: now() + 30 }),
    });
    expect(res.statusCode).toBe(200);
    const fresh = res.json<{ recoveryCodes: string[] }>().recoveryCodes;
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toContain(recoveryCodes[0]);
    const old = await call('POST', '/v1/me/mfa/recovery-codes', token, {
      recoveryCode: recoveryCodes[0] ?? '',
    });
    expect(old.statusCode).toBe(400);
  });

  it('turns two-step verification off with a recovery code, once', async () => {
    const { token, recoveryCodes } = await withMfa('off@me.test');
    const code = recoveryCodes[1] ?? '';
    expect(
      (await call('POST', '/v1/me/mfa/disable', token, { recoveryCode: code })).statusCode,
    ).toBe(204);
    expect((await call('GET', '/v1/me', token)).json()).toMatchObject({ mfaEnabled: false });
    // Off now: nothing left to disable, and signing in needs only the password.
    expect(
      (await call('POST', '/v1/me/mfa/disable', token, { recoveryCode: code })).statusCode,
    ).toBe(409);
    expect((await signIn('off@me.test')).json()).toMatchObject({ status: 'ok' });
  });

  it('refuses a wrong or replayed code and validates the proof', async () => {
    const { token, secret } = await withMfa('wrong@me.test');
    expect((await call('POST', '/v1/me/mfa/disable', token, { code: '000000' })).statusCode).toBe(
      400,
    );
    // The code that confirmed enrolment is spent (replay protection).
    const spent = await generate({ secret });
    expect((await call('POST', '/v1/me/mfa/disable', token, { code: spent })).statusCode).toBe(400);
    expect((await call('POST', '/v1/me/mfa/disable', token, { code: 'abc' })).statusCode).toBe(400);
    expect((await call('GET', '/v1/me', token)).json()).toMatchObject({ mfaEnabled: true });
  });

  it('answers 409 when two-step verification was never on', async () => {
    await api.seedUser(tenantId, 'never@me.test', PASSWORD);
    const token = await tokenOf('never@me.test');
    expect(
      (await call('POST', '/v1/me/mfa/recovery-codes', token, { code: '123456' })).statusCode,
    ).toBe(409);
  });
});
