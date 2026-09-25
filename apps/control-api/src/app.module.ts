import { Module, type DynamicModule } from '@nestjs/common';
import type { EmailSender } from '@sm/integrations';
import type { TokenBucketRateLimiter } from '@sm/server-kit';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { ServiceTokenGuard } from './auth/service-token.guard.js';
import { CellsController } from './cells/cells.controller.js';
import { CellsService } from './cells/cells.service.js';
import type { ControlApiConfig } from './config.js';
import { HealthController } from './health/health.controller.js';
import { IdempotencyService } from './idempotency/idempotency.service.js';
import type { ControlPlanePrisma } from './prisma.js';
import { TenantsController } from './tenants/tenants.controller.js';
import { TenantsService } from './tenants/tenants.service.js';
import { WorkspacesController } from './tenants/workspaces.controller.js';
import { CONFIG, EMAIL_SENDER, LOGGER, PRISMA, RATE_LIMITER, REDIS } from './tokens.js';

export interface ControlApiDependencies {
  config: ControlApiConfig;
  prisma: ControlPlanePrisma;
  redis: Redis;
  logger: Logger;
  email: EmailSender;
  limiter: TokenBucketRateLimiter;
}

@Module({})
export class ControlApiModule {
  static forRoot(deps: ControlApiDependencies): DynamicModule {
    return {
      module: ControlApiModule,
      global: true,
      controllers: [HealthController, CellsController, TenantsController, WorkspacesController],
      providers: [
        { provide: CONFIG, useValue: deps.config },
        { provide: PRISMA, useValue: deps.prisma },
        { provide: REDIS, useValue: deps.redis },
        { provide: LOGGER, useValue: deps.logger },
        { provide: EMAIL_SENDER, useValue: deps.email },
        { provide: RATE_LIMITER, useValue: deps.limiter },
        CellsService,
        TenantsService,
        IdempotencyService,
        ServiceTokenGuard,
      ],
    };
  }
}
