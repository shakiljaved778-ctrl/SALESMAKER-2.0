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
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  CreateListViewRequest,
  IfMatchHeaders,
  ListViewParam,
  ObjectParam,
  RunListViewRequest,
  UpdateListViewRequest,
} from '@sm/contracts';
import { withTenant, type CellPrisma, type TenantContext, type TenantTransaction } from '@sm/db';
import type { RecordContext } from '@sm/records';
import { ZodPipe } from '@sm/server-kit';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentTenant, TenantContextGuard } from '../tenancy/tenant-context.guard.js';
import { PRISMA } from '../tokens.js';
import { ListViewsService } from './list-views.service.js';
import { RecordContextService } from './record-context.service.js';

type Obj = z.infer<typeof ObjectParam>;
type ViewParam = z.infer<typeof ListViewParam>;

/** List views (§5.6, §9.11 T1); who may change which view is decided by ListViewsService. */
@Controller('v1/objects/:object/list-views')
@UseGuards(AuthGuard, TenantContextGuard)
export class ListViewsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly contexts: RecordContextService,
    private readonly views: ListViewsService,
  ) {}

  private run<T>(
    tenant: TenantContext,
    request: FastifyRequest,
    fn: (tx: TenantTransaction, ctx: RecordContext) => Promise<T>,
  ): Promise<T> {
    return withTenant(this.prisma, tenant, async (tx) =>
      fn(tx, await this.contexts.forCaller(tx, request.id)),
    );
  }

  @Get()
  list(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(ObjectParam)) p: Obj,
  ) {
    return this.run(t, req, (tx, ctx) => this.views.list(tx, ctx, p.object));
  }

  @Post()
  @HttpCode(201)
  create(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(ObjectParam)) p: Obj,
    @Body(new ZodPipe(CreateListViewRequest)) body: z.infer<typeof CreateListViewRequest>,
  ) {
    return this.run(t, req, (tx, ctx) => this.views.create(tx, ctx, p.object, body));
  }

  @Patch(':id')
  update(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Headers() headers: Record<string, unknown>,
    @Param(new ZodPipe(ListViewParam)) p: ViewParam,
    @Body(new ZodPipe(UpdateListViewRequest)) body: z.infer<typeof UpdateListViewRequest>,
  ) {
    const match = IfMatchHeaders.parse(headers)['if-match'];
    const version = match === undefined ? null : Number(match.replace(/\D/g, ''));
    return this.run(t, req, (tx, ctx) => this.views.update(tx, ctx, p.object, p.id, body, version));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(ListViewParam)) p: ViewParam,
  ) {
    await this.run(t, req, (tx, ctx) => this.views.remove(tx, ctx, p.object, p.id));
  }

  @Put(':id/pin')
  @HttpCode(204)
  async pin(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(ListViewParam)) p: ViewParam,
  ) {
    await this.run(t, req, (tx, ctx) => this.views.pin(tx, ctx, p.object, p.id));
  }

  @Post(':id/results')
  @HttpCode(200)
  results(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(ListViewParam)) p: ViewParam,
    @Body(new ZodPipe(RunListViewRequest)) body: z.infer<typeof RunListViewRequest>,
  ) {
    return this.run(t, req, (tx, ctx) => this.views.run(tx, ctx, p.object, p.id, body));
  }
}
