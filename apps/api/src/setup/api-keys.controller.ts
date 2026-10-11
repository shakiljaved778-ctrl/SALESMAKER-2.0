import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyIdParam, CreateApiKeyRequest, RotateApiKeyRequest } from '@sm/contracts';
import { withTenant, type CellPrisma, type TenantContext } from '@sm/db';
import { ZodPipe } from '@sm/server-kit';
import type { z } from 'zod';

import {
  RequireSystemPermission,
  SystemPermissionGuard,
} from '../access/system-permission.guard.js';
import { ApiKeysService } from '../auth/api-keys.service.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentTenant, TenantContextGuard } from '../tenancy/tenant-context.guard.js';
import { PRISMA } from '../tokens.js';

type Id = z.infer<typeof ApiKeyIdParam>;

/** Setup → API keys (§6, §10.1). Reading needs view_setup; keys act as users, so changes need manage_users. */
@Controller('v1/setup/api-keys')
@UseGuards(AuthGuard, TenantContextGuard, SystemPermissionGuard)
@RequireSystemPermission('view_setup')
export class ApiKeysController {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly keys: ApiKeysService,
  ) {}

  @Get()
  async list(@CurrentTenant() ctx: TenantContext) {
    return { items: await withTenant(this.prisma, ctx, (tx) => this.keys.list(tx)) };
  }

  @Post()
  @RequireSystemPermission('manage_users')
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body(new ZodPipe(CreateApiKeyRequest)) body: z.output<typeof CreateApiKeyRequest>,
  ) {
    return withTenant(this.prisma, ctx, (tx) => this.keys.create(tx, body));
  }

  @Post(':id/rotate')
  @RequireSystemPermission('manage_users')
  rotate(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(ApiKeyIdParam)) p: Id,
    @Body(new ZodPipe(RotateApiKeyRequest)) body: z.output<typeof RotateApiKeyRequest>,
  ) {
    return withTenant(this.prisma, ctx, (tx) => this.keys.rotate(tx, p.id, body));
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireSystemPermission('manage_users')
  async revoke(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(ApiKeyIdParam)) p: Id,
  ): Promise<void> {
    await withTenant(this.prisma, ctx, (tx) => this.keys.revoke(tx, p.id));
  }
}
