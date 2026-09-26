import {
  ControlPlaneUnavailableError,
  DomainError,
  emailRoutingHmac,
  HttpControlPlane,
  importEd25519PrivateKey,
} from '@sm/server-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PEPPER, startTestControlApi, type TestControlApi } from './support.js';

/**
 * Contract test: the HttpControlPlane client that cells use, against the real control-plane app
 * over real HTTP. If either side changes shape, this fails.
 */
let cp: TestControlApi;
let client: HttpControlPlane;

beforeAll(async () => {
  cp = await startTestControlApi();
  await cp.app.listen({ port: 0, host: '127.0.0.1' });
  const url = await cp.app.getUrl();
  client = new HttpControlPlane(
    url,
    'eu-central-1',
    await importEd25519PrivateKey(cp.privateKeyPem('eu-central-1')),
    'test',
  );
});

afterAll(async () => {
  await cp.dispose();
});

const hmac = (email: string) => emailRoutingHmac(email, PEPPER).toString('base64url');

describe('HttpControlPlane ⇄ control-api', () => {
  it('reserves (idempotently), activates and resolves a tenant', async () => {
    const input = {
      slug: 'contract-co',
      name: 'Contract Co',
      ownerEmailHmac: hmac('owner@contract.test'),
    };
    const first = await client.reserveTenant('signup:contract-0001', input);
    const retry = await client.reserveTenant('signup:contract-0001', input);
    expect(retry).toEqual(first);
    expect(first).toMatchObject({ slug: 'contract-co', status: 'PENDING', cellId: 'eu-central-1' });
    expect(await client.activateTenant(first.tenantId)).toMatchObject({ status: 'ACTIVE' });
  });

  it('pages through the cell’s tenant ids', async () => {
    const { tenantId } = await client.reserveTenant('signup:list-0001', {
      slug: 'listed-co',
      name: 'Listed Co',
      ownerEmailHmac: hmac('owner@listed.test'),
    });
    const ids: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await client.listCellTenants({ limit: 1, ...(after ? { after } : {}) });
      ids.push(...page.tenantIds);
      if (!page.next) break;
      after = page.next;
    }
    expect(ids).toContain(tenantId);
    expect((await client.listCellTenants()).tenantIds).toEqual(ids);
  });

  it('maps a taken slug to a 409 DomainError', async () => {
    await client.reserveTenant('signup:taken-0001', {
      slug: 'taken-contract',
      name: 'A',
      ownerEmailHmac: hmac('a@x.test'),
    });
    const error = await client
      .reserveTenant('signup:taken-0002', {
        slug: 'taken-contract',
        name: 'B',
        ownerEmailHmac: hmac('b@x.test'),
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).status).toBe(409);
  });

  it('releases a pending reservation', async () => {
    const reserved = await client.reserveTenant('signup:release-0001', {
      slug: 'release-me',
      name: 'R',
      ownerEmailHmac: hmac('r@x.test'),
    });
    await client.releaseTenant(reserved.tenantId);
    const again = await client.reserveTenant('signup:release-0002', {
      slug: 'release-me',
      name: 'R2',
      ownerEmailHmac: hmac('r@x.test'),
    });
    expect(again.tenantId).not.toBe(reserved.tenantId);
  });

  it('reports an unreachable control plane as ControlPlaneUnavailableError', async () => {
    const down = new HttpControlPlane(
      'http://127.0.0.1:1',
      'eu-central-1',
      await importEd25519PrivateKey(cp.privateKeyPem('eu-central-1')),
      'test',
    );
    await expect(
      down.activateTenant('01920000-0000-7000-8000-000000000001'),
    ).rejects.toBeInstanceOf(ControlPlaneUnavailableError);
  });
});
