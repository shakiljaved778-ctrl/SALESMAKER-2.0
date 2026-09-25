import { Body, Controller, Headers, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  OidcCallbackRequest,
  OidcProviderParam,
  OidcStartRequest,
  TenantHeader,
} from '@sm/contracts';
import { ZodPipe } from '@sm/server-kit';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { OidcService } from './oidc.service.js';

@Controller('auth/oidc')
export class OidcController {
  constructor(private readonly oidc: OidcService) {}

  @Post(':provider/start')
  @HttpCode(200)
  start(
    @Param(new ZodPipe(OidcProviderParam)) params: z.infer<typeof OidcProviderParam>,
    @Body(new ZodPipe(OidcStartRequest)) body: z.infer<typeof OidcStartRequest>,
  ) {
    return this.oidc.start(params.provider, body.redirectUri);
  }

  @Post(':provider/callback')
  @HttpCode(200)
  callback(
    @Param(new ZodPipe(OidcProviderParam)) params: z.infer<typeof OidcProviderParam>,
    @Headers() headers: Record<string, unknown>,
    @Body(new ZodPipe(OidcCallbackRequest)) body: z.infer<typeof OidcCallbackRequest>,
    @Req() request: FastifyRequest,
  ) {
    const tenantId = TenantHeader.parse(headers)['x-sm-tenant-id'];
    return this.oidc.signIn(tenantId, params.provider, body, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
  }
}
