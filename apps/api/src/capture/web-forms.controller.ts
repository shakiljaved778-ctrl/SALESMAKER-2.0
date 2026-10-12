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
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  CreateWebFormRequest,
  SetupIdParam,
  SubmitWebFormRequest,
  UpdateWebFormRequest,
  webFormRoutes,
} from '@sm/contracts';
import { withTenant, type CellPrisma, type TenantContext, type TenantTransaction } from '@sm/db';
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
import { PublicFormsService } from './public-forms.service.js';
import { WebFormsSetupService } from './web-forms-setup.service.js';

type Id = z.infer<typeof SetupIdParam>;
type Out<T extends z.ZodType> = z.output<T>;
const SubmissionsQuery = webFormRoutes.listWebFormSubmissions.request.query;
const PublicParams = webFormRoutes.getPublicWebForm.request.params;
const PublicQuery = webFormRoutes.getPublicWebForm.request.query;

/** Setup → Web forms (§7.1). Reading needs view_setup, changes customize_application. */
@Controller('v1/setup/web-forms')
@UseGuards(AuthGuard, TenantContextGuard, SystemPermissionGuard)
@RequireSystemPermission('view_setup')
export class WebFormsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly forms: WebFormsSetupService,
  ) {}

  private run<T>(ctx: TenantContext, fn: (tx: TenantTransaction) => Promise<T>) {
    return withTenant(this.prisma, ctx, fn);
  }

  @Get()
  async list(@CurrentTenant() ctx: TenantContext) {
    return { items: await this.run(ctx, (tx) => this.forms.list(tx)) };
  }
  @Get(':id')
  get(@CurrentTenant() ctx: TenantContext, @Param(new ZodPipe(SetupIdParam)) p: Id) {
    return this.run(ctx, (tx) => this.forms.get(tx, p.id));
  }
  @Get(':id/submissions')
  submissions(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(SetupIdParam)) p: Id,
    @Query(new ZodPipe(SubmissionsQuery)) q: Out<typeof SubmissionsQuery>,
  ) {
    return this.run(ctx, (tx) => this.forms.submissions(tx, p.id, q));
  }
  @Post()
  @RequireSystemPermission('customize_application')
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body(new ZodPipe(CreateWebFormRequest)) body: Out<typeof CreateWebFormRequest>,
  ) {
    return this.run(ctx, (tx) => this.forms.create(tx, body));
  }
  @Patch(':id')
  @RequireSystemPermission('customize_application')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(SetupIdParam)) p: Id,
    @Body(new ZodPipe(UpdateWebFormRequest)) body: Out<typeof UpdateWebFormRequest>,
  ) {
    return this.run(ctx, (tx) => this.forms.update(tx, p.id, body));
  }
  @Delete(':id')
  @HttpCode(204)
  @RequireSystemPermission('customize_application')
  async remove(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(SetupIdParam)) p: Id,
  ): Promise<void> {
    await this.run(ctx, (tx) => this.forms.remove(tx, p.id));
  }
}

/** Public web-to-lead (§7.1): no session; the tenant and an ACTIVE form come from the path. */
@Controller('v1/public/forms/:tenantId/:formId')
export class PublicFormsController {
  constructor(private readonly forms: PublicFormsService) {}

  @Get()
  describe(
    @Param(new ZodPipe(PublicParams)) p: z.infer<typeof PublicParams>,
    @Query(new ZodPipe(PublicQuery)) q: Out<typeof PublicQuery>,
  ) {
    return this.forms.describe(p.tenantId, p.formId, q.locale);
  }

  @Post('submissions')
  @HttpCode(202)
  submit(
    @Req() request: FastifyRequest,
    @Param(new ZodPipe(PublicParams)) p: z.infer<typeof PublicParams>,
    @Body(new ZodPipe(SubmitWebFormRequest)) body: Out<typeof SubmitWebFormRequest>,
  ) {
    return this.forms.submit(p.tenantId, p.formId, body, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
  }
}
