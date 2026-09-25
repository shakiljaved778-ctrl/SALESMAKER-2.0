import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { controlPlaneRoutes, IdempotencyHeaders, ReserveTenantRequest, Uuid } from '@sm/contracts';
import { errors, ZodPipe } from '@sm/server-kit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { ServiceTokenGuard } from '../auth/service-token.guard.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { TenantsService, type ReservedTenantDto } from './tenants.service.js';

const ResolveQuery = controlPlaneRoutes.resolveTenant.request.query;

function callerCell(request: FastifyRequest): string {
  const cellId = request.serviceCaller?.cellId;
  if (!cellId) throw errors.unauthenticated();
  return cellId;
}

@Controller('cp/v1/tenants')
export class TenantsController {
  constructor(
    private readonly tenants: TenantsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('resolve')
  resolve(@Query(new ZodPipe(ResolveQuery)) query: z.infer<typeof ResolveQuery>) {
    return this.tenants.resolveHost(query.host);
  }

  @Post('reserve')
  @UseGuards(ServiceTokenGuard)
  async reserve(
    @Headers() rawHeaders: Record<string, unknown>,
    @Body(new ZodPipe(ReserveTenantRequest)) body: z.infer<typeof ReserveTenantRequest>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ReservedTenantDto> {
    const headers = IdempotencyHeaders.parse(rawHeaders);
    const cellId = callerCell(reply.request);
    const result = await this.idempotency.run(
      `reserve:${cellId}`,
      headers['idempotency-key'],
      body,
      async (tx) => ({
        status: 201,
        body: await this.tenants.reserve(tx, cellId, body),
      }),
    );
    void reply.status(result.status);
    if (result.replayed) void reply.header('idempotent-replayed', 'true');
    return result.body;
  }

  @Post(':tenantId/activate')
  @HttpCode(200)
  @UseGuards(ServiceTokenGuard)
  activate(
    @Param('tenantId', new ZodPipe(Uuid)) tenantId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.tenants.activate(callerCell(reply.request), tenantId);
  }

  @Delete(':tenantId/reservation')
  @HttpCode(204)
  @UseGuards(ServiceTokenGuard)
  async release(
    @Param('tenantId', new ZodPipe(Uuid)) tenantId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.tenants.release(callerCell(reply.request), tenantId);
  }
}
