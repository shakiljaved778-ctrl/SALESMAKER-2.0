import { Module, type DynamicModule } from '@nestjs/common';
import type { CellPrisma } from '@sm/db';
import type { BreachedPasswordChecker, EmailSender } from '@sm/integrations';
import type { ControlPlane, SecretBox, TokenBucketRateLimiter } from '@sm/server-kit';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { AuthEmailService } from './auth/auth-email.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthService } from './auth/auth.service.js';
import { LockoutService } from './auth/lockout.service.js';
import { MeController } from './auth/me.controller.js';
import { MfaController } from './auth/mfa.controller.js';
import { MfaService } from './auth/mfa.service.js';
import { OidcController } from './auth/oidc.controller.js';
import { OidcService, type OidcProviders } from './auth/oidc.service.js';
import { PasswordService } from './auth/password.service.js';
import { SessionService } from './auth/session.service.js';
import { TokenService } from './auth/token.service.js';
import type { ApiConfig } from './config.js';
import { HealthController } from './health/health.controller.js';
import { OpenApiController } from './openapi/openapi.controller.js';
import { SignupController } from './signup/signup.controller.js';
import { PermissionService } from './permissions/permission.service.js';
import { SharingService } from './sharing/sharing.service.js';
import { SignupService } from './signup/signup.service.js';
import { TenantContextGuard } from './tenancy/tenant-context.guard.js';
import {
  BREACHED_PASSWORDS,
  CONFIG,
  CONTROL_PLANE,
  EMAIL_SENDER,
  LOGGER,
  PRISMA,
  OIDC_PROVIDERS,
  RATE_LIMITER,
  REDIS,
  SECRET_BOX,
} from './tokens.js';

export interface ApiDependencies {
  config: ApiConfig;
  prisma: CellPrisma;
  redis: Redis;
  logger: Logger;
  email: EmailSender;
  breachedPasswords: BreachedPasswordChecker;
  secretBox: SecretBox;
  oidcProviders: OidcProviders;
  controlPlane: ControlPlane;
  limiter: TokenBucketRateLimiter;
}

@Module({})
export class AppModule {
  static forRoot(deps: ApiDependencies): DynamicModule {
    return {
      module: AppModule,
      global: true,
      controllers: [
        HealthController,
        OpenApiController,
        AuthController,
        MeController,
        MfaController,
        OidcController,
        SignupController,
      ],
      providers: [
        { provide: CONFIG, useValue: deps.config },
        { provide: PRISMA, useValue: deps.prisma },
        { provide: REDIS, useValue: deps.redis },
        { provide: LOGGER, useValue: deps.logger },
        { provide: EMAIL_SENDER, useValue: deps.email },
        { provide: BREACHED_PASSWORDS, useValue: deps.breachedPasswords },
        { provide: SECRET_BOX, useValue: deps.secretBox },
        { provide: OIDC_PROVIDERS, useValue: deps.oidcProviders },
        { provide: CONTROL_PLANE, useValue: deps.controlPlane },
        { provide: RATE_LIMITER, useValue: deps.limiter },
        TenantContextGuard,
        AuthGuard,
        TokenService,
        PasswordService,
        LockoutService,
        SessionService,
        AuthEmailService,
        AuthService,
        MfaService,
        OidcService,
        SignupService,
        PermissionService,
        SharingService,
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
        PermissionService,
        SharingService,
      ],
    };
  }
}
