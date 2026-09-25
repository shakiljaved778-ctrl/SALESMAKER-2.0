import { Body, Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import {
  EmailRequest,
  LoginRequest,
  RefreshRequest,
  ResetPasswordRequest,
  TenantHeader,
  TokenRequest,
} from '@sm/contracts';
import { ZodPipe } from '@sm/server-kit';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { AuthService, type ClientInfo } from './auth.service.js';

function client(request: FastifyRequest): ClientInfo {
  return { ip: request.ip, userAgent: request.headers['user-agent'] };
}

/** Pre-auth routes (§6.1). The workspace comes from `x-sm-tenant-id`, set by the web BFF. */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  private async tenant(headers: Record<string, unknown>): Promise<string> {
    const tenantId = TenantHeader.parse(headers)['x-sm-tenant-id'];
    await this.auth.assertTenant(tenantId);
    return tenantId;
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Headers() headers: Record<string, unknown>,
    @Body(new ZodPipe(LoginRequest)) body: z.infer<typeof LoginRequest>,
    @Req() request: FastifyRequest,
  ) {
    return this.auth.login(await this.tenant(headers), body.email, body.password, client(request));
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Headers() headers: Record<string, unknown>,
    @Body(new ZodPipe(RefreshRequest)) body: z.infer<typeof RefreshRequest>,
  ) {
    return this.auth.refresh(await this.tenant(headers), body.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Headers() headers: Record<string, unknown>,
    @Body(new ZodPipe(RefreshRequest)) body: z.infer<typeof RefreshRequest>,
  ) {
    await this.auth.logout(await this.tenant(headers), body.refreshToken);
  }

  @Post('verify-email')
  @HttpCode(200)
  async verifyEmail(
    @Headers() headers: Record<string, unknown>,
    @Body(new ZodPipe(TokenRequest)) body: z.infer<typeof TokenRequest>,
  ) {
    await this.auth.verifyEmail(await this.tenant(headers), body.token);
    return { verified: true as const };
  }

  @Post('verify-email/resend')
  @HttpCode(202)
  async resend(
    @Headers() headers: Record<string, unknown>,
    @Body(new ZodPipe(EmailRequest)) body: z.infer<typeof EmailRequest>,
  ) {
    await this.auth.resendVerification(await this.tenant(headers), body.email);
  }

  @Post('password/forgot')
  @HttpCode(202)
  async forgot(
    @Headers() headers: Record<string, unknown>,
    @Body(new ZodPipe(EmailRequest)) body: z.infer<typeof EmailRequest>,
  ) {
    await this.auth.forgotPassword(await this.tenant(headers), body.email);
  }

  @Post('password/reset')
  @HttpCode(204)
  async reset(
    @Headers() headers: Record<string, unknown>,
    @Body(new ZodPipe(ResetPasswordRequest)) body: z.infer<typeof ResetPasswordRequest>,
  ) {
    await this.auth.resetPassword(await this.tenant(headers), body.token, body.newPassword);
  }
}
