import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SmtpEmailSender, type EmailSender } from '@sm/integrations';
import { createFastifyApp, createLogger, TokenBucketRateLimiter } from '@sm/server-kit';
import { Redis } from 'ioredis';

import { ControlApiModule } from './app.module.js';
import { CellsService } from './cells/cells.service.js';
import type { ControlApiConfig } from './config.js';
import { createControlPlanePrisma, disposeControlPlanePrisma } from './prisma.js';

export interface ControlApiApp {
  app: NestFastifyApplication;
  servedRoutes: string[];
  close(): Promise<void>;
}

export async function createControlApiApp(
  config: ControlApiConfig,
  overrides: { email?: EmailSender } = {},
): Promise<ControlApiApp> {
  const logger = createLogger({ service: 'control-api', level: config.LOG_LEVEL });
  const prisma = createControlPlanePrisma(config.CP_DATABASE_URL, (err) => {
    logger.warn({ err }, 'idle database connection lost; the pool will reconnect');
  });
  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  redis.on('error', (err) => {
    logger.warn({ err }, 'cache connection error');
  });
  await redis.connect().catch((err: unknown) => {
    logger.warn({ err }, 'cache unavailable at startup; continuing degraded');
  });
  const email = overrides.email ?? new SmtpEmailSender(config.SMTP_URL, config.EMAIL_FROM);
  const limiter = new TokenBucketRateLimiter(redis, config.RATE_LIMIT_NAMESPACE);
  const servedRoutes: string[] = [];

  const app = await createFastifyApp(
    ControlApiModule.forRoot({ config, prisma, redis, logger, email, limiter }),
    {
      logger,
      configure(nest) {
        nest
          .getHttpAdapter()
          .getInstance()
          .addHook('onRoute', (route) => {
            const methods = Array.isArray(route.method) ? route.method : [route.method];
            for (const m of methods) if (m !== 'HEAD') servedRoutes.push(`${m} ${route.url}`);
          });
      },
    },
  );
  await app.init();
  await app.get(CellsService).sync();
  await app.getHttpAdapter().getInstance().ready();

  return {
    app,
    servedRoutes,
    async close() {
      await app.close();
      await disposeControlPlanePrisma(prisma);
      redis.disconnect();
    },
  };
}
