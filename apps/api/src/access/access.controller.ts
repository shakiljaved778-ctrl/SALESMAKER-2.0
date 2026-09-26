import { Controller, Get, Inject, Param, UseGuards } from '@nestjs/common';
import { accessRoutes } from '@sm/contracts';
import { withTenant, type CellPrisma, type TenantContext } from '@sm/db';
import { errors, ZodPipe } from '@sm/server-kit';
import type { z } from 'zod';

import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentTenant, TenantContextGuard } from '../tenancy/tenant-context.guard.js';
import { PRISMA } from '../tokens.js';
import { AccessService } from './access.service.js';

const Params = accessRoutes.explainRecordAccess.request.params;

@Controller('v1/me/access')
@UseGuards(AuthGuard, TenantContextGuard)
export class AccessController {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly access: AccessService,
  ) {}

  /** "Why can I see this?" (§6.3). A record the caller cannot see is a 404, never a 403. */
  @Get(':object/:id')
  explain(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(Params)) params: z.infer<typeof Params>,
  ) {
    return withTenant(this.prisma, ctx, async (tx) => {
      const result = await this.access.describe(tx, ctx.userId ?? '', params.object, params.id);
      if (!result) throw errors.notFound('Record');
      return { object: params.object, recordId: params.id, ...result };
    });
  }
}
