import { ReservedTenant, type ProblemDetails } from '@sm/contracts';
import type { z } from 'zod';

import { DomainError } from './problem.js';
import { signServiceToken, type SigningKey } from './service-token.js';

export type ReservedTenantDto = z.infer<typeof ReservedTenant>;

/** What a cell needs from the control plane (§3.4). Implemented over HTTP, or faked in tests. */
export interface ControlPlane {
  reserveTenant(
    idempotencyKey: string,
    input: { slug: string; name: string; ownerEmailHmac: string },
  ): Promise<ReservedTenantDto>;
  activateTenant(tenantId: string): Promise<ReservedTenantDto>;
  releaseTenant(tenantId: string): Promise<void>;
}

export class ControlPlaneUnavailableError extends Error {
  constructor(cause: unknown) {
    super('The control plane is unavailable', { cause });
    this.name = 'ControlPlaneUnavailableError';
  }
}

/**
 * HTTP client for the control plane's service routes. Every call carries a fresh 60-second EdDSA
 * service token issued by this cell. Problem responses are re-raised as DomainErrors with the
 * same code and status (e.g. 409 slug taken); transport failures raise
 * ControlPlaneUnavailableError so callers can compensate.
 */
export class HttpControlPlane implements ControlPlane {
  constructor(
    private readonly baseUrl: string,
    private readonly cellId: string,
    private readonly signingKey: SigningKey,
    private readonly kid: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 5_000,
  ) {}

  async reserveTenant(
    idempotencyKey: string,
    input: { slug: string; name: string; ownerEmailHmac: string },
  ) {
    return ReservedTenant.parse(
      await this.call('POST', '/cp/v1/tenants/reserve', input, {
        'idempotency-key': idempotencyKey,
      }),
    );
  }

  async activateTenant(tenantId: string) {
    return ReservedTenant.parse(
      await this.call('POST', `/cp/v1/tenants/${encodeURIComponent(tenantId)}/activate`),
    );
  }

  async releaseTenant(tenantId: string): Promise<void> {
    await this.call('DELETE', `/cp/v1/tenants/${encodeURIComponent(tenantId)}/reservation`);
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<unknown> {
    const token = await signServiceToken(this.signingKey, { cellId: this.cellId, kid: this.kid });
    const url = `${this.baseUrl.replace(/\/$/, '')}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ControlPlaneUnavailableError(error);
    }
    if (res.status === 204) return undefined;
    const payload: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const problem = payload as Partial<ProblemDetails> | undefined;
      if (problem?.code && res.status < 500) {
        throw new DomainError(
          problem.code,
          res.status,
          problem.detail ?? problem.title ?? 'Control plane request failed',
        );
      }
      throw new ControlPlaneUnavailableError(
        new Error(`control plane answered ${String(res.status)}`),
      );
    }
    return payload;
  }
}
