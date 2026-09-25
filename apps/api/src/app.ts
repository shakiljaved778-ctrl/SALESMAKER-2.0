import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createCellPrisma, disposeCellPrisma } from '@sm/db';
import {
  createFastifyApp,
  createLogger,
  rateLimitHeaders,
  requestContext,
  TokenBucketRateLimiter,
} from '@sm/server-kit';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { AppModule, type ApiDependencies } from './app.module.js';
import type { ApiConfig } from './config.js';

export interface ApiApp {
  app: NestFastifyApplication;
  /** Method + URL of every route Fastify serves (for the contract-coverage test). */
  servedRoutes: string[];
  close(): Promise<void>;
}

const UNLIMITED_PREFIXES = ['/health'];

/**
 * Build the cell API. Infrastructure can be injected (tests); otherwise it is created from
 * config. The pre-auth rate limit is per client IP (§3.6); per-tenant and per-user limits from
 * the plan are applied after authentication (T10, P05).
 */
export async function createApiApp(
  config: ApiConfig,
  overrides: Partial<Omit<ApiDependencies, 'config'>> = {},
): Promise<ApiApp> {
  const logger: Logger =
    overrides.logger ?? createLogger({ service: 'api', level: config.LOG_LEVEL });
  const prisma =
    overrides.prisma ??
    createCellPrisma(config.CELL_DATABASE_URL, {
      maxConnections: config.DB_POOL_MAX,
      onStatement: () => {
        requestContext.countDbStatement();
      },
      onPoolError: (err) => {
        logger.warn({ err }, 'idle database connection lost; the pool will reconnect');
      },
    });
  const redis =
    overrides.redis ??
    new Redis(config.REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
  redis.on('error', (err) => {
    logger.warn({ err }, 'cache connection error');
  });
  if (redis.status === 'wait') {
    // Connect before serving; if Valkey is down, start degraded (readiness says so) and let
    // ioredis keep reconnecting rather than refusing to boot (§11.3).
    await redis.connect().catch((err: unknown) => {
      logger.warn({ err }, 'cache unavailable at startup; continuing degraded');
    });
  }
  const limiter = new TokenBucketRateLimiter(redis, config.RATE_LIMIT_NAMESPACE);
  const servedRoutes: string[] = [];

  const app = await createFastifyApp(AppModule.forRoot({ config, prisma, redis, logger }), {
    logger,
    configure(nest) {
      const fastify = nest.getHttpAdapter().getInstance();
      fastify.addHook('onRoute', (route) => {
        const methods = Array.isArray(route.method) ? route.method : [route.method];
        for (const m of methods) if (m !== 'HEAD') servedRoutes.push(`${m} ${route.url}`);
      });
      fastify.addHook('onRequest', async (request, reply) => {
        if (UNLIMITED_PREFIXES.some((p) => request.url.startsWith(p))) return;
        try {
          const result = await limiter.consume(`ip:${request.ip}`, {
            capacity: config.RATE_LIMIT_IP_BURST,
            refillPerSecond: config.RATE_LIMIT_IP_PER_SECOND,
          });
          void reply.headers(rateLimitHeaders(result));
          if (!result.allowed) {
            await reply
              .status(429)
              .header('content-type', 'application/problem+json')
              .header('retry-after', String(Math.max(1, result.resetSeconds)))
              .send({
                type: 'https://developers.salesmaker.app/problems/rate-limited',
                title: 'Too many requests',
                status: 429,
                code: 'rate_limited',
                detail: 'Too many requests. Wait a moment and try again.',
                instance: request.url.split('?')[0],
                traceId: request.id,
              });
          }
        } catch (err) {
          // Fail open: an unavailable cache must not take the CRM down (§11.3). Alerting covers it.
          logger.warn({ err }, 'rate limiter unavailable; allowing request');
        }
      });
    },
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return {
    app,
    servedRoutes,
    async close() {
      await app.close();
      if (!overrides.prisma) await disposeCellPrisma(prisma);
      if (!overrides.redis) redis.disconnect();
    },
  };
}
