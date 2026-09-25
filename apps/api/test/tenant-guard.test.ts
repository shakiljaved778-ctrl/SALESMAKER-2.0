import type { ExecutionContext } from '@nestjs/common';
import { DomainError, requestContext } from '@sm/server-kit';
import { describe, expect, it } from 'vitest';

import type { ApiConfig } from '../src/config.js';
import { TenantContextGuard, type VerifiedCaller } from '../src/tenancy/tenant-context.guard.js';

// The guard only reads CELL_ID; the rest of the config is irrelevant here.
const config = { CELL_ID: 'eu-central-1' } as ApiConfig;

function contextWith(caller?: VerifiedCaller): ExecutionContext {
  const request = { caller };
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

const caller: VerifiedCaller = {
  tenantId: '01920000-0000-7000-8000-00000000000a',
  userId: '01920000-0000-7000-8000-0000000000ff',
  cellId: 'eu-central-1',
};

describe('TenantContextGuard (§3.6)', () => {
  const guard = new TenantContextGuard(config);

  it('rejects a request with no verified caller as 401', () => {
    expect(() => guard.canActivate(contextWith())).toThrow(DomainError);
    try {
      guard.canActivate(contextWith());
    } catch (e) {
      expect((e as DomainError).status).toBe(401);
    }
  });

  it('answers 404, not 403, for a credential issued by another cell', () => {
    try {
      guard.canActivate(contextWith({ ...caller, cellId: 'me-central-1' }));
      expect.unreachable();
    } catch (e) {
      expect((e as DomainError).status).toBe(404);
    }
  });

  it('admits a caller of this cell and publishes tenant and user to the request context', () => {
    requestContext.run({ requestId: 'req-abcdefgh', dbStatements: 0 }, () => {
      expect(guard.canActivate(contextWith(caller))).toBe(true);
      expect(requestContext.get()).toMatchObject({
        tenantId: caller.tenantId,
        userId: caller.userId,
      });
    });
  });
});
