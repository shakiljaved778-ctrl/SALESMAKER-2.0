import { Body, Controller, Headers, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { MfaChallengeRequest, MfaConfirmRequest, TenantHeader } from '@sm/contracts';
import type { TenantContext } from '@sm/db';
import { ZodPipe } from '@sm/server-kit';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { CurrentTenant, TenantContextGuard } from '../tenancy/tenant-context.guard.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { MfaService } from './mfa.service.js';

@Controller('auth/mfa')
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    private readonly auth: AuthService,
  ) {}

  @Post('totp/enroll')
  @HttpCode(200)
  @UseGuards(AuthGuard, TenantContextGuard)
  enroll(@CurrentTenant() ctx: TenantContext) {
    return this.mfa.enroll(ctx);
  }

  @Post('totp/confirm')
  @HttpCode(200)
  @UseGuards(AuthGuard, TenantContextGuard)
  confirm(
    @CurrentTenant() ctx: TenantContext,
    @Body(new ZodPipe(MfaConfirmRequest)) body: z.infer<typeof MfaConfirmRequest>,
  ) {
    return this.mfa.confirm(ctx, body.code);
  }

  @Post('challenge')
  @HttpCode(200)
  async challenge(
    @Headers() headers: Record<string, unknown>,
    @Body(new ZodPipe(MfaChallengeRequest)) body: z.infer<typeof MfaChallengeRequest>,
    @Req() request: FastifyRequest,
  ) {
    const tenantId = TenantHeader.parse(headers)['x-sm-tenant-id'];
    await this.auth.assertTenant(tenantId);
    return this.mfa.challenge(tenantId, body, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
  }
}
