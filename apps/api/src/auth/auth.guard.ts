import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { DomainError, errors, rateLimitHeaders, type TokenBucketRateLimiter } from '@sm/server-kit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';

import type { ApiConfig } from '../config.js';
import { apiRoutes } from '../openapi/routes.js';
import { CONFIG, LOGGER, RATE_LIMITER } from '../tokens.js';
import { ApiKeysService, isApiKey } from './api-keys.service.js';
import { SessionService } from './session.service.js';
import { TokenService } from './token.service.js';

/** `GET /v1/records/:object` for every route published to API keys (§10.1); the rest are internal. */
const API_KEY_ROUTES = new Set(
  apiRoutes
    .filter((r) => r.visibility === 'public-api' && r.auth === 'session')
    .map((r) => `${r.method.toUpperCase()} ${r.path.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1')}`),
);

/**
 * Authentication step of the request lifecycle (§3.6): a Bearer access token or API key is
 * verified and becomes `request.caller`. The tenant comes from the credential, never from a header
 * or body. API keys reach only the published routes (internal ones answer 404, §10.2) and are
 * rate limited per key. (OAuth tokens join here in P12.)
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly apiKeys: ApiKeysService,
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(RATE_LIMITER) private readonly limiter: TokenBucketRateLimiter,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) throw errors.unauthenticated();
    const credential = header.slice('Bearer '.length);
    if (isApiKey(credential)) {
      await this.authenticateApiKey(request, context.switchToHttp().getResponse(), credential);
      return true;
    }
    const claims = await this.tokens.verifyAccessToken(credential);
    // A remotely signed-out session's access tokens stop working at once (§6.1).
    if (await this.sessions.isRevoked(claims.sessionId))
      throw errors.unauthenticated('Your session has ended. Sign in again.');
    request.caller = {
      tenantId: claims.tenantId,
      userId: claims.userId,
      cellId: claims.cellId,
      sessionId: claims.sessionId,
    };
    return true;
  }

  private async authenticateApiKey(
    request: FastifyRequest,
    reply: FastifyReply,
    credential: string,
  ): Promise<void> {
    if (!API_KEY_ROUTES.has(`${request.method} ${request.routeOptions.url ?? ''}`))
      throw errors.notFound();
    const caller = await this.apiKeys.authenticate(credential);
    await this.rateLimit(reply, caller.apiKeyId);
    request.caller = { ...caller, cellId: this.config.CELL_ID };
  }

  /** Per-key token bucket with the standard headers (§10.1); fails open like the IP limit. */
  private async rateLimit(reply: FastifyReply, apiKeyId: string): Promise<void> {
    let result;
    try {
      result = await this.limiter.consume(`key:${apiKeyId}`, {
        capacity: this.config.RATE_LIMIT_API_KEY_BURST,
        refillPerSecond: this.config.RATE_LIMIT_API_KEY_PER_SECOND,
      });
    } catch (err) {
      this.logger.warn({ err }, 'rate limiter unavailable; allowing request');
      return;
    }
    const headers = rateLimitHeaders(result);
    void reply.headers(headers);
    if (!result.allowed)
      throw new DomainError(
        'rate_limited',
        429,
        'This API key is over its rate limit. Wait a moment and try again.',
        undefined,
        { ...headers, 'retry-after': String(Math.max(1, result.resetSeconds)) },
      );
  }
}
