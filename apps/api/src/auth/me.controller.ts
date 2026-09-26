import { Body, Controller, Get, HttpCode, Inject, Patch, Post, UseGuards } from '@nestjs/common';
import {
  ChangePasswordRequest,
  MfaProofRequest,
  PreferencesPatch,
  UpdateMyProfileRequest,
} from '@sm/contracts';
import { withTenant, type CellPrisma, type TenantContext } from '@sm/db';
import { ZodPipe } from '@sm/server-kit';
import type { z } from 'zod';

import {
  CurrentCaller,
  CurrentTenant,
  TenantContextGuard,
  type VerifiedCaller,
} from '../tenancy/tenant-context.guard.js';
import { PRISMA } from '../tokens.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { MfaService } from './mfa.service.js';

@Controller('v1/me')
@UseGuards(AuthGuard, TenantContextGuard)
export class MeController {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
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

  /** Personal settings → Profile: the caller's own name, job title and phone. */
  @Patch('profile')
  updateProfile(
    @CurrentTenant() ctx: TenantContext,
    @Body(new ZodPipe(UpdateMyProfileRequest)) body: z.infer<typeof UpdateMyProfileRequest>,
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

  /** Personal settings → Security: change the password; other sessions end. */
  @Post('password')
  @HttpCode(204)
  async changePassword(
    @CurrentTenant() ctx: TenantContext,
    @CurrentCaller() caller: VerifiedCaller,
    @Body(new ZodPipe(ChangePasswordRequest)) body: z.infer<typeof ChangePasswordRequest>,
  ): Promise<void> {
    await withTenant(this.prisma, ctx, (tx) =>
      this.auth.changePassword(tx, caller.userId, caller.sessionId, body),
    );
  }

  @Post('mfa/disable')
  @HttpCode(204)
  async disableMfa(
    @CurrentTenant() ctx: TenantContext,
    @Body(new ZodPipe(MfaProofRequest)) body: z.infer<typeof MfaProofRequest>,
  ): Promise<void> {
    await this.mfa.disable(ctx, body);
  }

  @Post('mfa/recovery-codes')
  @HttpCode(200)
  regenerateRecoveryCodes(
    @CurrentTenant() ctx: TenantContext,
    @Body(new ZodPipe(MfaProofRequest)) body: z.infer<typeof MfaProofRequest>,
  ) {
    return this.mfa.regenerateRecoveryCodes(ctx, body);
  }
}
