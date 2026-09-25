import { Module, type DynamicModule } from '@nestjs/common';
import type { CellPrisma } from '@sm/db';
import type { BreachedPasswordChecker, EmailSender } from '@sm/integrations';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { AuthEmailService } from './auth/auth-email.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { LockoutService } from './auth/lockout.service.js';
import { MeController } from './auth/me.controller.js';
import { PasswordService } from './auth/password.service.js';
import { SessionService } from './auth/session.service.js';
import { TokenService } from './auth/token.service.js';
import type { ApiConfig } from './config.js';
import { HealthController } from './health/health.controller.js';
import { OpenApiController } from './openapi/openapi.controller.js';
import { TenantContextGuard } from './tenancy/tenant-context.guard.js';
import { BREACHED_PASSWORDS, CONFIG, EMAIL_SENDER, LOGGER, PRISMA, REDIS } from './tokens.js';

export interface ApiDependencies {
  config: ApiConfig;
  prisma: CellPrisma;
  redis: Redis;
  logger: Logger;
  email: EmailSender;
  breachedPasswords: BreachedPasswordChecker;
}

@Module({})
export class AppModule {
  static forRoot(deps: ApiDependencies): DynamicModule {
    return {
      module: AppModule,
      global: true,
      controllers: [HealthController, OpenApiController, AuthController, MeController],
      providers: [
        { provide: CONFIG, useValue: deps.config },
        { provide: PRISMA, useValue: deps.prisma },
        { provide: REDIS, useValue: deps.redis },
        { provide: LOGGER, useValue: deps.logger },
        { provide: EMAIL_SENDER, useValue: deps.email },
        { provide: BREACHED_PASSWORDS, useValue: deps.breachedPasswords },
        TenantContextGuard,
        AuthGuard,
        TokenService,
        PasswordService,
        LockoutService,
        SessionService,
        AuthEmailService,
        AuthService,
      ],
      exports: [
        CONFIG,
        PRISMA,
        REDIS,
        LOGGER,
        TenantContextGuard,
        AuthGuard,
        AuthService,
        PasswordService,
        SessionService,
        TokenService,
      ],
    };
  }
}
