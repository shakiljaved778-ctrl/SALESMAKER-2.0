import { Body, Controller, Headers, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  IdempotencyHeaders,
  OidcProviderParam,
  OidcSignupRequest,
  SignupRequest,
} from '@sm/contracts';
import { ZodPipe } from '@sm/server-kit';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { SignupService } from './signup.service.js';

const client = (request: FastifyRequest) => ({
  ip: request.ip,
  userAgent: request.headers['user-agent'],
});

@Controller('auth/signup')
export class SignupController {
  constructor(private readonly signups: SignupService) {}

  @Post()
  @HttpCode(201)
  signup(
    @Headers() headers: Record<string, unknown>,
    @Body(new ZodPipe(SignupRequest)) body: z.infer<typeof SignupRequest>,
    @Req() request: FastifyRequest,
  ) {
    const key = IdempotencyHeaders.parse(headers)['idempotency-key'];
    return this.signups.signup(key, body, client(request));
  }

  @Post('oidc/:provider')
  @HttpCode(201)
  signupWithOidc(
    @Param(new ZodPipe(OidcProviderParam)) params: z.infer<typeof OidcProviderParam>,
    @Headers() headers: Record<string, unknown>,
    @Body(new ZodPipe(OidcSignupRequest)) body: z.infer<typeof OidcSignupRequest>,
    @Req() request: FastifyRequest,
  ) {
    const key = IdempotencyHeaders.parse(headers)['idempotency-key'];
    return this.signups.signupWithOidc(key, params.provider, body, client(request));
  }
}
