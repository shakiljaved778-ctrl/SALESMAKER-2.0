import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { errors } from '@sm/server-kit';
import type { FastifyRequest } from 'fastify';

import { TokenService } from './token.service.js';

/**
 * Authentication step of the request lifecycle (§3.6): a Bearer access token is verified and
 * becomes `request.caller`. The tenant comes from the token, never from a header or body.
 * (API keys and OAuth tokens join here in P03/P12.)
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly tokens: TokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) throw errors.unauthenticated();
    const claims = await this.tokens.verifyAccessToken(header.slice('Bearer '.length));
    request.caller = {
      tenantId: claims.tenantId,
      userId: claims.userId,
      cellId: claims.cellId,
      sessionId: claims.sessionId,
    };
    return true;
  }
}
