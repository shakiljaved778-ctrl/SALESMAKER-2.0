import { Body, Controller, Get, Inject, Patch, UseGuards } from '@nestjs/common';
import { PreferencesPatch } from '@sm/contracts';
import { withTenant, type CellPrisma, type TenantContext } from '@sm/db';
import { ZodPipe } from '@sm/server-kit';
import type { z } from 'zod';

import { CurrentTenant, TenantContextGuard } from '../tenancy/tenant-context.guard.js';
import { PRISMA } from '../tokens.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';

@Controller('v1/me')
@UseGuards(AuthGuard, TenantContextGuard)
export class MeController {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly auth: AuthService,
  ) {}

  @Get()
  me(@CurrentTenant() ctx: TenantContext) {
    return withTenant(this.prisma, ctx, (tx) => this.auth.me(tx, ctx.userId ?? ''));
  }

  @Patch('preferences')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Body(new ZodPipe(PreferencesPatch)) body: z.infer<typeof PreferencesPatch>,
  ) {
    return withTenant(this.prisma, ctx, async (tx) => {
      const userId = ctx.userId ?? '';
      await tx.prisma.user.update({
        where: { tenantId_id: { tenantId: ctx.tenantId, id: userId } },
        data: { ...body, version: { increment: 1 }, updatedBy: userId },
      });
      return this.auth.me(tx, userId);
    });
  }
}
