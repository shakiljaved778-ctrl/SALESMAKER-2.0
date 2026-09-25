import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestControlApi, type TestControlApi } from './support.js';

let cp: TestControlApi;

beforeAll(async () => {
  cp = await startTestControlApi();
});

afterAll(async () => {
  await cp.dispose();
});

async function reserve(
  slug: string,
  options: { key?: string; cell?: 'eu-central-1' | 'me-central-1' | 'rogue'; email?: string } = {},
) {
  return cp.app.inject({
    method: 'POST',
    url: '/cp/v1/tenants/reserve',
    headers: {
      authorization: `Bearer ${await cp.tokenFor(options.cell ?? 'eu-central-1')}`,
      'idempotency-key': options.key ?? `key-${slug}-${String(Math.random())}`,
    },
    payload: {
      slug,
      name: `${slug} Ltd`,
      ownerEmailHmac: cp.hmac(options.email ?? `owner@${slug}.test`),
    },
  });
}

async function service(
  method: 'POST' | 'DELETE',
  url: string,
  cell: 'eu-central-1' | 'me-central-1' = 'eu-central-1',
) {
  return cp.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${await cp.tokenFor(cell)}` },
  });
}

describe('GET /cp/v1/cells', () => {
  it('lists the configured regions', async () => {
    const res = await cp.app.inject({ method: 'GET', url: '/cp/v1/cells' });
    expect(res.json()).toEqual({
      cells: [
        {
          id: 'eu-central-1',
          region: 'eu-central-1',
          label: 'European Union',
          apiBaseUrl: 'http://eu.api.test',
          signupOpen: true,
        },
        {
          id: 'me-central-1',
          region: 'me-central-1',
          label: 'UAE (GCC)',
          apiBaseUrl: 'http://me.api.test',
          signupOpen: false,
        },
      ],
    });
  });
});

describe('POST /cp/v1/tenants/reserve', () => {
  it('requires a valid service token from a registered cell', async () => {
    const anonymous = await cp.app.inject({
      method: 'POST',
      url: '/cp/v1/tenants/reserve',
      payload: {},
    });
    expect(anonymous.statusCode).toBe(401);
    const rogue = await reserve('rogue-co', { cell: 'rogue' });
    expect(rogue.statusCode).toBe(401);
  });

  it('reserves a slug as PENDING in the calling cell', async () => {
    const res = await reserve('pixelcraft');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      slug: 'pixelcraft',
      status: 'PENDING',
      cellId: 'eu-central-1',
    });
  });

  it('replays the same response for a retried Idempotency-Key and refuses a reused key with a different body', async () => {
    const first = await reserve('acme', { key: 'idem-acme-0001' });
    const retry = await reserve('acme', { key: 'idem-acme-0001' });
    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.json()).toEqual(first.json());
    const reused = await reserve('acme-two', { key: 'idem-acme-0001' });
    expect(reused.statusCode).toBe(422);
    expect(reused.json()).toMatchObject({ code: 'idempotency_key_reused' });
  });

  it('rejects taken, platform-reserved and invalid slugs', async () => {
    await reserve('taken-co');
    expect((await reserve('taken-co')).statusCode).toBe(409);
    expect((await reserve('www')).statusCode).toBe(409);
    const invalid = await reserve('Not Valid');
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'validation_failed' });
  });

  it('refuses signups in a region that is closed to new organisations', async () => {
    const res = await reserve('gulf-co', { cell: 'me-central-1' });
    expect(res.statusCode).toBe(403);
  });
});

describe('tenant lifecycle', () => {
  it('resolves a workspace host to its tenant and cell', async () => {
    await reserve('bravo');
    const res = await cp.app.inject({
      method: 'GET',
      url: '/cp/v1/tenants/resolve?host=bravo.localhost:3000',
    });
    expect(res.json()).toMatchObject({
      slug: 'bravo',
      status: 'PENDING',
      cell: { id: 'eu-central-1', apiBaseUrl: 'http://eu.api.test' },
    });
    const unknown = await cp.app.inject({
      method: 'GET',
      url: '/cp/v1/tenants/resolve?host=nobody.localhost:3000',
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('activates idempotently, and answers 404 to any other cell', async () => {
    const { tenantId } = (await reserve('charlie')).json<{ tenantId: string }>();
    expect(
      (await service('POST', `/cp/v1/tenants/${tenantId}/activate`, 'me-central-1')).statusCode,
    ).toBe(404);
    const once = await service('POST', `/cp/v1/tenants/${tenantId}/activate`);
    const twice = await service('POST', `/cp/v1/tenants/${tenantId}/activate`);
    expect(once.json()).toMatchObject({ status: 'ACTIVE' });
    expect(twice.statusCode).toBe(200);
  });

  it('releases a pending reservation (compensation) but never an active tenant', async () => {
    const pending = (await reserve('delta')).json<{ tenantId: string }>();
    expect(
      (await service('DELETE', `/cp/v1/tenants/${pending.tenantId}/reservation`)).statusCode,
    ).toBe(204);
    expect(
      (await service('DELETE', `/cp/v1/tenants/${pending.tenantId}/reservation`)).statusCode,
    ).toBe(204);
    expect(
      (
        await cp.app.inject({
          method: 'GET',
          url: '/cp/v1/tenants/resolve?host=delta.localhost:3000',
        })
      ).statusCode,
    ).toBe(404);

    const active = (await reserve('echo')).json<{ tenantId: string }>();
    await service('POST', `/cp/v1/tenants/${active.tenantId}/activate`);
    expect(
      (await service('DELETE', `/cp/v1/tenants/${active.tenantId}/reservation`)).statusCode,
    ).toBe(409);
  });

  it('lets a lapsed reservation’s slug be taken again', async () => {
    await reserve('foxtrot');
    const db = new pg.Client({ connectionString: cp.dbUrl });
    await db.connect();
    await db.query(
      "UPDATE cp_tenant SET reserved_until = now() - interval '1 minute' WHERE slug = 'foxtrot'",
    );
    await db.end();
    expect(
      (
        await cp.app.inject({
          method: 'GET',
          url: '/cp/v1/tenants/resolve?host=foxtrot.localhost:3000',
        })
      ).statusCode,
    ).toBe(404);
    expect((await reserve('foxtrot')).statusCode).toBe(201);
  });
});

describe('POST /cp/v1/workspaces/find', () => {
  it('always answers 202 and emails the workspace list to the address', async () => {
    const { tenantId } = (await reserve('golf', { email: 'Owner@Golf.test' })).json<{
      tenantId: string;
    }>();
    await service('POST', `/cp/v1/tenants/${tenantId}/activate`);

    const res = await cp.app.inject({
      method: 'POST',
      url: '/cp/v1/workspaces/find',
      payload: { email: 'owner@golf.test' },
    });
    expect(res.statusCode).toBe(202);
    await expect
      .poll(() => cp.email.lastTo('owner@golf.test')?.text ?? '')
      .toContain('http://golf.localhost:3000');

    const unknown = await cp.app.inject({
      method: 'POST',
      url: '/cp/v1/workspaces/find',
      payload: { email: 'nobody@nowhere.test' },
    });
    expect(unknown.statusCode).toBe(202);
    await expect
      .poll(() => cp.email.lastTo('nobody@nowhere.test')?.text ?? '')
      .toContain("couldn't find any workspaces");
  });

  it('stores no plaintext email address anywhere in the control plane (spec v1.2)', async () => {
    const db = new pg.Client({ connectionString: cp.dbUrl });
    await db.connect();
    const { rows } = await db.query<{ n: number }>(`
      SELECT count(*)::int AS n FROM (
        SELECT row_to_json(t)::text AS j FROM cp_tenant t
        UNION ALL SELECT row_to_json(r)::text FROM cp_user_routing r
        UNION ALL SELECT row_to_json(i)::text FROM cp_idempotency_key i
      ) all_rows WHERE j ILIKE '%@%'`);
    await db.end();
    expect(rows).toEqual([{ n: 0 }]);
  });
});
