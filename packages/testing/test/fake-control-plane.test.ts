import { ControlPlaneUnavailableError, DomainError } from '@sm/server-kit';
import { describe, expect, it } from 'vitest';

import { FakeControlPlane } from '../src/index.js';

const owner = { name: 'Acme', ownerEmailHmac: 'hmac' };

describe('FakeControlPlane', () => {
  it('reserves idempotently and rejects a taken slug', async () => {
    const cp = new FakeControlPlane('me-central-1');
    const first = await cp.reserveTenant('k1', { slug: 'acme', ...owner });
    expect(first).toMatchObject({ slug: 'acme', status: 'PENDING', cellId: 'me-central-1' });
    expect(await cp.reserveTenant('k1', { slug: 'acme', ...owner })).toEqual(first);
    await expect(cp.reserveTenant('k2', { slug: 'acme', ...owner })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('uses nextTenantId once, then generates ids again', async () => {
    const cp = new FakeControlPlane();
    cp.nextTenantId = '00000000-0000-7000-8000-000000000001';
    const a = await cp.reserveTenant('a', { slug: 'a', ...owner });
    const b = await cp.reserveTenant('b', { slug: 'b', ...owner });
    expect(a.tenantId).toBe('00000000-0000-7000-8000-000000000001');
    expect(b.tenantId).not.toBe(a.tenantId);
    expect(a.cellId).toBe('eu-central-1');
  });

  it('activates a reservation and refuses to release an active tenant', async () => {
    const cp = new FakeControlPlane();
    const { tenantId } = await cp.reserveTenant('k', { slug: 'acme', ...owner });
    expect(await cp.activateTenant(tenantId)).toMatchObject({ status: 'ACTIVE' });
    expect(cp.statusOf(tenantId)).toBe('ACTIVE');
    await expect(cp.releaseTenant(tenantId)).rejects.toBeInstanceOf(DomainError);
    await expect(cp.activateTenant('missing')).rejects.toMatchObject({ status: 404 });
  });

  it('releases a pending reservation, freeing the slug and the idempotency key', async () => {
    const cp = new FakeControlPlane();
    const first = await cp.reserveTenant('k', { slug: 'acme', ...owner });
    await cp.releaseTenant(first.tenantId);
    expect(cp.statusOf(first.tenantId)).toBeUndefined();
    const again = await cp.reserveTenant('k', { slug: 'acme', ...owner });
    expect(again.tenantId).not.toBe(first.tenantId);
  });

  it('pages through its tenants in id order', async () => {
    const cp = new FakeControlPlane();
    for (const slug of ['a', 'b', 'c']) await cp.reserveTenant(slug, { slug, ...owner });
    const all = await cp.listCellTenants();
    expect(all.tenantIds).toEqual([...cp.tenants.keys()].sort());
    expect(all.next).toBeNull();
    const first = await cp.listCellTenants({ limit: 2 });
    expect(first.next).toBe(first.tenantIds[1]);
    const rest = await cp.listCellTenants({ limit: 2, after: first.next ?? '' });
    expect([...first.tenantIds, ...rest.tenantIds]).toEqual(all.tenantIds);
    expect(rest.next).toBeNull();
  });

  it('simulates an outage on every call', async () => {
    const cp = new FakeControlPlane();
    cp.unavailable = true;
    await expect(cp.reserveTenant('k', { slug: 'x', ...owner })).rejects.toBeInstanceOf(
      ControlPlaneUnavailableError,
    );
    await expect(cp.activateTenant('t')).rejects.toBeInstanceOf(ControlPlaneUnavailableError);
    await expect(cp.releaseTenant('t')).rejects.toBeInstanceOf(ControlPlaneUnavailableError);
    await expect(cp.listCellTenants()).rejects.toBeInstanceOf(ControlPlaneUnavailableError);
  });
});
