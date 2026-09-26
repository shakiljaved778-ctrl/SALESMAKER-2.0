import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  AcceptInvitationRequest,
  InviteUserRequest,
  TenantHeader,
  UpdateUserRequest,
  UserAssignmentsRequest,
  UserListQuery,
  userRoutes,
} from '@sm/contracts';
import { withTenant, type CellPrisma, type TenantContext } from '@sm/db';
import { ZodPipe } from '@sm/server-kit';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import {
  RequireSystemPermission,
  SystemPermissionGuard,
} from '../access/system-permission.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentTenant, TenantContextGuard } from '../tenancy/tenant-context.guard.js';
import { PRISMA } from '../tokens.js';
import { UsersService } from './users.service.js';

const IdParam = userRoutes.getUser.request.params;
type Id = z.infer<typeof IdParam>;

/** Setup → Users (§6.1): reading needs view_setup, every change manage_users. */
@Controller('v1')
@UseGuards(AuthGuard, TenantContextGuard, SystemPermissionGuard)
@RequireSystemPermission('view_setup')
export class UsersController {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly users: UsersService,
  ) {}

  @Get('users')
  list(
    @CurrentTenant() ctx: TenantContext,
    @Query(new ZodPipe(UserListQuery)) q: z.infer<typeof UserListQuery>,
  ) {
    return withTenant(this.prisma, ctx, (tx) => this.users.list(tx, q));
  }

  @Get('users/:id')
  get(@CurrentTenant() ctx: TenantContext, @Param(new ZodPipe(IdParam)) p: Id) {
    return withTenant(this.prisma, ctx, (tx) => this.users.detail(tx, p.id));
  }

  @Patch('users/:id')
  @RequireSystemPermission('manage_users')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(IdParam)) p: Id,
    @Body(new ZodPipe(UpdateUserRequest)) body: z.infer<typeof UpdateUserRequest>,
  ) {
    return withTenant(this.prisma, ctx, (tx) => this.users.update(tx, p.id, body));
  }

  @Put('users/:id/assignments')
  @RequireSystemPermission('manage_users')
  assignments(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(IdParam)) p: Id,
    @Body(new ZodPipe(UserAssignmentsRequest)) body: z.infer<typeof UserAssignmentsRequest>,
  ) {
    return withTenant(this.prisma, ctx, (tx) => this.users.setAssignments(tx, p.id, body));
  }

  @Post('users/:id/deactivate')
  @HttpCode(200)
  @RequireSystemPermission('manage_users')
  deactivate(@CurrentTenant() ctx: TenantContext, @Param(new ZodPipe(IdParam)) p: Id) {
    return withTenant(this.prisma, ctx, (tx) => this.users.deactivate(tx, p.id));
  }

  @Post('users/:id/reactivate')
  @HttpCode(200)
  @RequireSystemPermission('manage_users')
  reactivate(@CurrentTenant() ctx: TenantContext, @Param(new ZodPipe(IdParam)) p: Id) {
    return withTenant(this.prisma, ctx, (tx) => this.users.reactivate(tx, p.id));
  }

  @Post('invitations')
  @HttpCode(201)
  @RequireSystemPermission('manage_users')
  invite(
    @CurrentTenant() ctx: TenantContext,
    @Body(new ZodPipe(InviteUserRequest)) body: z.infer<typeof InviteUserRequest>,
  ) {
    return this.users.invite(ctx.tenantId, ctx.userId ?? '', body);
  }

  @Post('invitations/:id/resend')
  @HttpCode(200)
  @RequireSystemPermission('manage_users')
  resend(@CurrentTenant() ctx: TenantContext, @Param(new ZodPipe(IdParam)) p: Id) {
    return this.users.resendInvitation(ctx.tenantId, ctx.userId ?? '', p.id);
  }

  @Delete('invitations/:id')
  @HttpCode(204)
  @RequireSystemPermission('manage_users')
  async revoke(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(IdParam)) p: Id,
  ): Promise<void> {
    await withTenant(this.prisma, ctx, (tx) => this.users.revokeInvitation(tx, p.id));
  }
}

/** Accepting an invitation is pre-auth, named by the workspace header like sign-in (§10.2). */
@Controller('auth/invitations')
export class InvitationsController {
  constructor(private readonly users: UsersService) {}

  @Post('accept')
  @HttpCode(200)
  accept(
    @Headers() headers: Record<string, unknown>,
    @Body(new ZodPipe(AcceptInvitationRequest)) body: z.infer<typeof AcceptInvitationRequest>,
    @Req() request: FastifyRequest,
  ) {
    const tenantId = TenantHeader.parse(headers)['x-sm-tenant-id'];
    return this.users.acceptInvitation(tenantId, body, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
  }
}
