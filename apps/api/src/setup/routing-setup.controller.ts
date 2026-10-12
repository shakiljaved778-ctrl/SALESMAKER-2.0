import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  CreateBusinessHoursRequest,
  PutUserRoutingRequest,
  SetupIdParam,
  UpdateBusinessHoursRequest,
} from '@sm/contracts';
import { withTenant, type CellPrisma, type TenantContext, type TenantTransaction } from '@sm/db';
import { hasSystemPermission } from '@sm/permissions';
import { errors, ZodPipe } from '@sm/server-kit';
import type { z } from 'zod';

import { AccessService } from '../access/access.service.js';
import {
  RequireSystemPermission,
  SystemPermissionGuard,
} from '../access/system-permission.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentTenant, TenantContextGuard } from '../tenancy/tenant-context.guard.js';
import { PRISMA } from '../tokens.js';
import { RoutingSetupService } from './routing-setup.service.js';

type Id = z.infer<typeof SetupIdParam>;
type Out<T extends z.ZodType> = z.output<T>;

/** Setup → Business hours (§7.3). Reading needs view_setup, changes customize_application. */
@Controller('v1/setup/business-hours')
@UseGuards(AuthGuard, TenantContextGuard, SystemPermissionGuard)
@RequireSystemPermission('view_setup')
export class BusinessHoursController {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly routing: RoutingSetupService,
  ) {}

  private run<T>(ctx: TenantContext, fn: (tx: TenantTransaction) => Promise<T>) {
    return withTenant(this.prisma, ctx, fn);
  }

  @Get()
  async list(@CurrentTenant() ctx: TenantContext) {
    return { items: await this.run(ctx, (tx) => this.routing.list(tx)) };
  }
  @Get(':id')
  get(@CurrentTenant() ctx: TenantContext, @Param(new ZodPipe(SetupIdParam)) p: Id) {
    return this.run(ctx, (tx) => this.routing.get(tx, p.id));
  }
  @Post()
  @RequireSystemPermission('customize_application')
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body(new ZodPipe(CreateBusinessHoursRequest)) body: Out<typeof CreateBusinessHoursRequest>,
  ) {
    return this.run(ctx, (tx) => this.routing.create(tx, body));
  }
  @Patch(':id')
  @RequireSystemPermission('customize_application')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(SetupIdParam)) p: Id,
    @Body(new ZodPipe(UpdateBusinessHoursRequest)) body: Out<typeof UpdateBusinessHoursRequest>,
  ) {
    return this.run(ctx, (tx) => this.routing.update(tx, p.id, body));
  }
  @Delete(':id')
  @HttpCode(204)
  @RequireSystemPermission('customize_application')
  async remove(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(SetupIdParam)) p: Id,
  ): Promise<void> {
    await this.run(ctx, (tx) => this.routing.remove(tx, p.id));
  }
}

/**
 * A user's routing settings (§7.3). Users read and change their own availability (working hours,
 * out of office); view_setup reads anyone's; manage_users changes anything, skills and capacity
 * included.
 */
@Controller('v1/users/:id/routing')
@UseGuards(AuthGuard, TenantContextGuard)
export class UserRoutingController {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly routing: RoutingSetupService,
    private readonly access: AccessService,
  ) {}

  @Get()
  get(@CurrentTenant() ctx: TenantContext, @Param(new ZodPipe(SetupIdParam)) p: Id) {
    return withTenant(this.prisma, ctx, async (tx) => {
      if (p.id !== ctx.userId)
        await this.access.requireSystemPermission(tx, ctx.userId ?? '', 'view_setup');
      return this.routing.userRouting(tx, p.id);
    });
  }

  @Put()
  put(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(SetupIdParam)) p: Id,
    @Body(new ZodPipe(PutUserRoutingRequest)) body: Out<typeof PutUserRoutingRequest>,
  ) {
    return withTenant(this.prisma, ctx, async (tx) => {
      const admin = hasSystemPermission(
        await this.access.permissionsOf(tx, ctx.userId ?? ''),
        'manage_users',
      );
      const own = p.id === ctx.userId && body.skills === undefined && body.capacity === undefined;
      if (!admin && !own) throw errors.forbidden();
      return this.routing.putUserRouting(tx, p.id, body);
    });
  }
}
