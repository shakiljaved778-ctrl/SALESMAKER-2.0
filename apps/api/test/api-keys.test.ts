import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { encodeApiKey, parseApiKey } from '../src/auth/api-keys.service.js';
import { setupFixture, type Method, type SetupFixture } from './setup-fixture.js';

let f: SetupFixture;
type Json = Record<string, unknown>;
const json = (res: { body: string }) => JSON.parse(res.body) as Json;
const BURST = 20;

beforeAll(async () => {
  f = await setupFixture(
    'apikeys',
    {},
    {
      RATE_LIMIT_API_KEY_BURST: BURST,
      RATE_LIMIT_API_KEY_PER_SECOND: 0.01,
    },
  );
  // `rep` becomes the integration user: a Standard User plus "API enabled".
  await f.inTenant(async (tx) => {
    const set = await tx.prisma.permissionSet.create({
      data: { tenantId: f.tenantId, name: 'Integration' },
    });
    await tx.prisma.systemPermission.create({
      data: { tenantId: f.tenantId, permissionSetId: set.id, name: 'api_enabled' },
    });
    await tx.prisma.permissionAssignment.create({
      data: { tenantId: f.tenantId, userId: f.id('rep'), permissionSetId: set.id },
    });
    f.set('set:integration', set.id);
  });
});

afterAll(async () => {
  await f.api.dispose();
});

async function createKey(payload: Json = {}) {
  const res = await f.call('admin', 'POST', '/v1/setup/api-keys', {
    name: 'Website sync',
    runAsUserId: f.id('rep'),
    ...payload,
  });
  expect(res.statusCode, res.body).toBe(201);
  const body = json(res) as { key: Json & { id: string }; secret: string };
  return body;
}

const withKey = (secret: string, method: Method, url: string, payload?: Json) =>
  f.api.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${secret}` },
    ...(payload ? { payload } : {}),
  });

describe('Setup → API keys', () => {
  it('creates a key whose secret is shown once and never stored', async () => {
    const { key, secret } = await createKey({ environment: 'TEST' });
    expect(secret).toMatch(/^sm_test_[A-Za-z0-9_-]{86}$/);
    expect(key).toMatchObject({
      name: 'Website sync',
      environment: 'TEST',
      preview: `sm_test_…${secret.slice(-4)}`,
      runAsUser: { id: f.id('rep') },
      status: 'active',
      lastUsedAt: null,
    });
    expect(parseApiKey(secret)).toMatchObject({ tenantId: f.tenantId, keyId: key.id });

    const list = await f.call('viewer', 'GET', '/v1/setup/api-keys');
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(secret);
    expect(list.body).not.toContain(secret.slice(8, 40));
    const row = await f.inTenant((tx) =>
      tx.prisma.apiKey.findFirstOrThrow({ where: { id: key.id } }),
    );
    expect(row.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(secret.slice(8));
    const audited = await f.inTenant((tx) =>
      tx.prisma.setupAudit.findFirstOrThrow({
        where: { action: 'api_key.created', entityId: key.id },
      }),
    );
    expect(JSON.stringify(audited.after)).not.toContain(secret.slice(8));
  });

  it('refuses a run-as user who is not API enabled, inactive or unknown, and past expiries', async () => {
    const field = async (payload: Json) => {
      const res = await f.call('admin', 'POST', '/v1/setup/api-keys', {
        name: 'Bad',
        runAsUserId: f.id('rep'),
        ...payload,
      });
      expect(res.statusCode).toBe(400);
      return (json(res)['errors'] as Json[])[0];
    };
    expect(await field({ runAsUserId: f.id('peer') })).toMatchObject({ code: 'not_api_enabled' });
    expect(await field({ runAsUserId: f.id('outsider') })).toMatchObject({ code: 'not_found' });
    expect(await field({ expiresAt: '2020-01-01T00:00:00Z' })).toMatchObject({ code: 'in_past' });
    expect(await field({ environment: 'STAGING' })).toMatchObject({ field: 'environment' });
    expect(await field({ name: '' })).toMatchObject({ field: 'name' });
  });

  it('is guarded: view_setup lists, manage_users changes, other workspaces see nothing', async () => {
    const { key } = await createKey();
    await f.expectGuarded('GET', '/v1/setup/api-keys', {});
    await f.expectGuarded('POST', '/v1/setup/api-keys', {
      payload: { name: 'X', runAsUserId: f.id('rep') },
    });
    await f.expectGuarded('POST', `/v1/setup/api-keys/${key.id}/rotate`, { payload: {} });
    await f.expectGuarded('DELETE', `/v1/setup/api-keys/${key.id}`, {});
    const outsiderList = await f.call('outsider', 'GET', '/v1/setup/api-keys');
    expect(outsiderList.statusCode).toBe(200);
    expect(json(outsiderList)['items']).toEqual([]);
  });
});

describe('calling the API with a key', () => {
  it('runs public routes as the run-as user, with rate-limit headers and last-used tracking', async () => {
    const { key, secret } = await createKey();
    const objects = await withKey(secret, 'GET', '/v1/objects');
    expect(objects.statusCode, objects.body).toBe(200);
    expect(objects.headers['ratelimit-limit']).toBe(String(BURST));
    expect(Number(objects.headers['ratelimit-remaining'])).toBe(BURST - 1);

    const created = await withKey(secret, 'POST', '/v1/records/lead', {
      fields: { last_name: 'Api', company: 'Integrations Co' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const lead = json(created) as { id: string } & Json;
    expect(lead['owner_id']).toMatchObject({ id: f.id('rep') });
    const read = await withKey(secret, 'GET', `/v1/records/lead/${lead.id}`);
    expect(read.statusCode).toBe(200);
    expect(
      (await withKey(secret, 'POST', '/v1/query', { object: 'lead', fields: ['last_name'] }))
        .statusCode,
    ).toBe(200);
    expect((await withKey(secret, 'GET', '/v1/search?q=Integrations')).statusCode).toBe(200);

    const [row] = await f.inTenant((tx) => tx.prisma.apiKey.findMany({ where: { id: key.id } }));
    expect(row?.lastUsedAt).toBeInstanceOf(Date);
  });

  it('cannot reach internal routes (404)', async () => {
    const { secret } = await createKey();
    for (const [method, url] of [
      ['GET', '/v1/me'],
      ['GET', '/v1/recent-items'],
      ['GET', '/v1/setup/api-keys'],
      ['POST', '/v1/setup/api-keys'],
      ['GET', '/v1/me/sessions'],
    ] as const)
      expect((await withKey(secret, method, url, {})).statusCode, url).toBe(404);
  });

  it('answers 401 for malformed, tampered, mis-prefixed or forged keys alike', async () => {
    const { key, secret } = await createKey();
    const parsed = parseApiKey(secret);
    if (!parsed) throw new Error('unparseable');
    const flipped = Buffer.from(parsed.secret);
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    const candidates = [
      'sm_live_short',
      `${secret}x`,
      secret.replace('sm_live_', 'sm_test_'),
      encodeApiKey('LIVE', f.tenantId, key.id, flipped),
      // The same key id and secret presented as another workspace's.
      encodeApiKey('LIVE', f.otherTenant, key.id, parsed.secret),
    ];
    for (const candidate of candidates) {
      const res = await withKey(candidate, 'GET', '/v1/objects');
      expect(res.statusCode, candidate).toBe(401);
      expect(json(res)['detail']).toBe('The API key is not valid');
    }
  });

  it('stops working when revoked, expired, or its user is disabled; 403 without API enabled', async () => {
    const revoked = await createKey();
    expect(
      (await f.call('admin', 'DELETE', `/v1/setup/api-keys/${revoked.key.id}`)).statusCode,
    ).toBe(204);
    expect((await withKey(revoked.secret, 'GET', '/v1/objects')).statusCode).toBe(401);
    // Revoking twice is harmless.
    expect(
      (await f.call('admin', 'DELETE', `/v1/setup/api-keys/${revoked.key.id}`)).statusCode,
    ).toBe(204);
    const list = await f.call('admin', 'GET', '/v1/setup/api-keys');
    expect((json(list)['items'] as Json[]).find((k) => k['id'] === revoked.key.id)).toMatchObject({
      status: 'revoked',
    });

    const expiring = await createKey({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await f.inTenant((tx) =>
      tx.prisma.apiKey.updateMany({
        where: { id: expiring.key.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      }),
    );
    expect((await withKey(expiring.secret, 'GET', '/v1/objects')).statusCode).toBe(401);

    const { secret } = await createKey();
    await f.inTenant((tx) =>
      tx.prisma.permissionAssignment.deleteMany({
        where: { userId: f.id('rep'), permissionSetId: f.id('set:integration') },
      }),
    );
    await f.inTenant((tx) =>
      tx.prisma.tenantSettings.update({
        where: { tenantId: f.tenantId },
        data: { permVersion: { increment: 1 } },
      }),
    );
    const denied = await withKey(secret, 'GET', '/v1/objects');
    expect(denied.statusCode, denied.body).toBe(403);
    await f.inTenant(async (tx) => {
      await tx.prisma.permissionAssignment.create({
        data: {
          tenantId: f.tenantId,
          userId: f.id('rep'),
          permissionSetId: f.id('set:integration'),
        },
      });
      await tx.prisma.tenantSettings.update({
        where: { tenantId: f.tenantId },
        data: { permVersion: { increment: 1 } },
      });
    });
    expect((await withKey(secret, 'GET', '/v1/objects')).statusCode).toBe(200);

    await f.inTenant((tx) =>
      tx.prisma.user.updateMany({ where: { id: f.id('rep') }, data: { status: 'DISABLED' } }),
    );
    try {
      expect((await withKey(secret, 'GET', '/v1/objects')).statusCode).toBe(401);
    } finally {
      await f.inTenant((tx) =>
        tx.prisma.user.updateMany({ where: { id: f.id('rep') }, data: { status: 'ACTIVE' } }),
      );
    }
  });

  it('rotates: the new key works at once, the old one until the grace period ends', async () => {
    const original = await createKey();
    const graced = await f.call('admin', 'POST', `/v1/setup/api-keys/${original.key.id}/rotate`, {
      graceMinutes: 60,
    });
    expect(graced.statusCode, graced.body).toBe(201);
    const next = json(graced) as { key: Json & { id: string }; secret: string };
    expect(next.key).toMatchObject({ rotatedFromId: original.key.id, status: 'active' });
    expect(next.secret).not.toBe(original.secret);
    expect((await withKey(next.secret, 'GET', '/v1/objects')).statusCode).toBe(200);
    expect((await withKey(original.secret, 'GET', '/v1/objects')).statusCode).toBe(200);

    const immediate = await f.call('admin', 'POST', `/v1/setup/api-keys/${next.key.id}/rotate`, {});
    expect(immediate.statusCode).toBe(201);
    expect((await withKey(next.secret, 'GET', '/v1/objects')).statusCode).toBe(401);
    expect(
      (await f.call('admin', 'POST', `/v1/setup/api-keys/${next.key.id}/rotate`, {})).statusCode,
    ).toBe(409);
    expect(
      (
        await f.call('admin', 'POST', `/v1/setup/api-keys/${original.key.id}/rotate`, {
          graceMinutes: 100_000,
        })
      ).statusCode,
    ).toBe(400);
    const audited = await f.inTenant((tx) =>
      tx.prisma.setupAudit.count({ where: { action: 'api_key.rotated' } }),
    );
    expect(audited).toBe(2);
  });

  it('rate limits each key on its own (429 with Retry-After)', async () => {
    const { secret } = await createKey();
    const other = await createKey();
    let last;
    for (let i = 0; i <= BURST; i += 1) last = await withKey(secret, 'GET', '/v1/objects');
    expect(last?.statusCode).toBe(429);
    expect(json(last ?? { body: '{}' })['code']).toBe('rate_limited');
    expect(Number(last?.headers['retry-after'])).toBeGreaterThan(0);
    expect(last?.headers['ratelimit-remaining']).toBe('0');
    expect((await withKey(other.secret, 'GET', '/v1/objects')).statusCode).toBe(200);
  });
});
