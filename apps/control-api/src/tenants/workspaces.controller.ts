import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { FindWorkspacesRequest } from '@sm/contracts';
import { renderWorkspacesEmail } from '@sm/emails';
import type { EmailSender } from '@sm/integrations';
import { emailRoutingHmac, TokenBucketRateLimiter, ZodPipe } from '@sm/server-kit';
import type { FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { z } from 'zod';

import type { ControlApiConfig } from '../config.js';
import { CONFIG, EMAIL_SENDER, LOGGER, RATE_LIMITER } from '../tokens.js';
import { TenantsService } from './tenants.service.js';

/**
 * "Find my workspaces" (spec v1.2): always answers 202, so the response never reveals whether an
 * address has an account. The email goes out in the background (uniform response time), at
 * most 3 per address per hour, and the endpoint is limited per IP.
 */
@Controller('cp/v1/workspaces')
export class WorkspacesController {
  constructor(
    @Inject(CONFIG) private readonly config: ControlApiConfig,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(RATE_LIMITER) private readonly limiter: TokenBucketRateLimiter,
    private readonly tenants: TenantsService,
  ) {}

  @Post('find')
  @HttpCode(202)
  async find(
    @Body(new ZodPipe(FindWorkspacesRequest)) body: z.infer<typeof FindWorkspacesRequest>,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    const hmac = emailRoutingHmac(body.email, this.config.EMAIL_ROUTING_PEPPER).toString(
      'base64url',
    );
    const [perIp, perAddress] = await Promise.all([
      this.limiter.consume(`find:ip:${request.ip}`, { capacity: 10, refillPerSecond: 10 / 3600 }),
      this.limiter.consume(`find:email:${hmac}`, { capacity: 3, refillPerSecond: 3 / 3600 }),
    ]).catch(() => [{ allowed: true }, { allowed: true }]);
    if (!perIp.allowed || !perAddress.allowed) return;

    void this.send(body.email, body.locale ?? 'en', hmac).catch((err: unknown) => {
      this.logger.error({ err }, 'find-workspaces email failed');
    });
  }

  private async send(email: string, locale: string, hmac: string): Promise<void> {
    const workspaces = await this.tenants.workspacesFor(email);
    const rendered = await renderWorkspacesEmail({ locale, workspaces });
    const hourBucket = Math.floor(Date.now() / 3_600_000);
    await this.email.send({
      to: email,
      ...rendered,
      idempotencyKey: `workspaces:${hmac}:${String(hourBucket)}`,
    });
  }
}
