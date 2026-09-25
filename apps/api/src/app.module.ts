import { Module, type DynamicModule } from '@nestjs/common';
import type { CellPrisma } from '@sm/db';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import type { ApiConfig } from './config.js';
import { HealthController } from './health/health.controller.js';
import { OpenApiController } from './openapi/openapi.controller.js';
import { TenantContextGuard } from './tenancy/tenant-context.guard.js';
import { CONFIG, LOGGER, PRISMA, REDIS } from './tokens.js';

export interface ApiDependencies {
  config: ApiConfig;
  prisma: CellPrisma;
  redis: Redis;
  logger: Logger;
}

@Module({})
export class AppModule {
  static forRoot(deps: ApiDependencies): DynamicModule {
    return {
      module: AppModule,
      global: true,
      controllers: [HealthController, OpenApiController],
      providers: [
        { provide: CONFIG, useValue: deps.config },
        { provide: PRISMA, useValue: deps.prisma },
        { provide: REDIS, useValue: deps.redis },
        { provide: LOGGER, useValue: deps.logger },
        TenantContextGuard,
      ],
      exports: [CONFIG, PRISMA, REDIS, LOGGER, TenantContextGuard],
    };
  }
}
