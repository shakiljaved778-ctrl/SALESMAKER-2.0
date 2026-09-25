import {
  ControlPlaneUnavailableError,
  DomainError,
  type ControlPlane,
  type ReservedTenantDto,
} from '@sm/server-kit';
import { uuidv7 } from 'uuidv7';

/**
 * In-memory control plane for cell tests: same semantics as apps/control-api for the calls a
 * cell makes (idempotent reserve, slug uniqueness, idempotent activate, release of PENDING only).
 * `unavailable` simulates an outage; the real HTTP path is covered by a contract test.
 */
export class FakeControlPlane implements ControlPlane {
  readonly tenants = new Map<string, ReservedTenantDto & { ownerEmailHmac: string }>();
  private readonly replies = new Map<string, ReservedTenantDto>();
  unavailable = false;
  /** Make the next reservation use this tenant id (to exercise compensation paths). */
  nextTenantId: string | undefined;

  constructor(private readonly cellId = 'eu-central-1') {}

  reserveTenant(
    idempotencyKey: string,
    input: { slug: string; name: string; ownerEmailHmac: string },
  ): Promise<ReservedTenantDto> {
    if (this.unavailable)
      return Promise.reject(new ControlPlaneUnavailableError(new Error('fake outage')));
    const replay = this.replies.get(idempotencyKey);
    if (replay) return Promise.resolve(replay);
    if ([...this.tenants.values()].some((t) => t.slug === input.slug)) {
      return Promise.reject(new DomainError('conflict', 409, 'That workspace address is taken'));
    }
    const tenantId = this.nextTenantId ?? uuidv7();
    this.nextTenantId = undefined;
    const tenant: ReservedTenantDto = {
      tenantId,
      slug: input.slug,
      status: 'PENDING',
      cellId: this.cellId,
    };
    this.tenants.set(tenant.tenantId, { ...tenant, ownerEmailHmac: input.ownerEmailHmac });
    this.replies.set(idempotencyKey, tenant);
    return Promise.resolve(tenant);
  }

  activateTenant(tenantId: string): Promise<ReservedTenantDto> {
    if (this.unavailable)
      return Promise.reject(new ControlPlaneUnavailableError(new Error('fake outage')));
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return Promise.reject(new DomainError('not_found', 404, 'Tenant not found'));
    tenant.status = 'ACTIVE';
    return Promise.resolve({
      tenantId: tenant.tenantId,
      slug: tenant.slug,
      status: tenant.status,
      cellId: tenant.cellId,
    });
  }

  releaseTenant(tenantId: string): Promise<void> {
    if (this.unavailable)
      return Promise.reject(new ControlPlaneUnavailableError(new Error('fake outage')));
    const tenant = this.tenants.get(tenantId);
    if (tenant?.status === 'ACTIVE')
      return Promise.reject(
        new DomainError('conflict', 409, 'Only a pending reservation can be released'),
      );
    this.tenants.delete(tenantId);
    for (const [key, reply] of this.replies)
      if (reply.tenantId === tenantId) this.replies.delete(key);
    return Promise.resolve();
  }

  statusOf(tenantId: string): string | undefined {
    return this.tenants.get(tenantId)?.status;
  }
}
