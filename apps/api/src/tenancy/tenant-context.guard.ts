import {
  createParamDecorator,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { TenantContext } from '@sm/db';
import { errors, requestContext } from '@sm/server-kit';
import type { FastifyRequest } from 'fastify';

import type { ApiConfig } from '../config.js';
import { CONFIG } from '../tokens.js';

/**
 * The verified caller, set on the request by the authentication guard (session JWT, API key or
 * OAuth token; P00 T10 and later) — never taken from headers, query or body.
 */
export interface VerifiedCaller {
  tenantId: string;
  userId: string;
  /** Cell that issued the credential; must match the cell serving the request. */
  cellId: string;
  sessionId?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    caller?: VerifiedCaller;
  }
}

/**
 * TenantContext step of the request lifecycle (§3.6): requires a verified caller whose credential
 * belongs to **this** cell, then publishes tenant and user to logs and spans. A credential from
 * another cell gets 404 (never 403) so a tenant's existence is not leaked (§3.5).
 */
@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: ApiConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const caller = request.caller;
    if (!caller) throw errors.unauthenticated();
    if (caller.cellId !== this.config.CELL_ID) throw errors.notFound();
    requestContext.identify(caller.tenantId, caller.userId);
    return true;
  }
}

/** Handler parameter: the TenantContext for withTenant(). Only valid behind TenantContextGuard. */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantContext => {
    const caller = context.switchToHttp().getRequest<FastifyRequest>().caller;
    if (!caller) throw errors.unauthenticated();
    return { tenantId: caller.tenantId, userId: caller.userId };
  },
);

/** Handler parameter: the whole verified caller (e.g. for its session id). */
export const CurrentCaller = createParamDecorator(
  (_data: unknown, context: ExecutionContext): VerifiedCaller => {
    const caller = context.switchToHttp().getRequest<FastifyRequest>().caller;
    if (!caller) throw errors.unauthenticated();
    return caller;
  },
);
