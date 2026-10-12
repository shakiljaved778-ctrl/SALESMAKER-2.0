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
  AnalyseImportRequest,
  CreateImportRequest,
  CreateImportTemplateRequest,
  importRoutes,
  ImportRowsQuery,
  ImportsQuery,
  UpdateImportRequest,
} from '@sm/contracts';
import { withTenant, type CellPrisma, type TenantContext, type TenantTransaction } from '@sm/db';
import type { RecordContext } from '@sm/records';
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
import { ImportsService } from './imports.service.js';
import { RecordContextService } from './record-context.service.js';

const IdParam = importRoutes.getImport.request.params;
const TemplatesQuery = importRoutes.listImportTemplates.request.query;
type Id = z.infer<typeof IdParam>;
type Out<T extends z.ZodType> = z.output<T>;

/** Data import (§7.1). Every route needs import_records. */
@Controller('v1')
@UseGuards(AuthGuard, TenantContextGuard, SystemPermissionGuard)
@RequireSystemPermission('import_records')
export class ImportsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly contexts: RecordContextService,
    private readonly imports: ImportsService,
  ) {}

  private run<T>(
    t: TenantContext,
    request: FastifyRequest,
    fn: (tx: TenantTransaction, ctx: RecordContext) => Promise<T>,
  ) {
    return withTenant(this.prisma, t, async (tx) =>
      fn(tx, await this.contexts.forCaller(tx, request.id)),
    );
  }

  @Get('imports')
  list(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Query(new ZodPipe(ImportsQuery)) q: Out<typeof ImportsQuery>,
  ) {
    return this.run(t, req, (tx, ctx) => this.imports.list(tx, ctx, q));
  }

  @Post('imports')
  create(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Body(new ZodPipe(CreateImportRequest)) body: Out<typeof CreateImportRequest>,
  ) {
    return this.run(t, req, (tx, ctx) => this.imports.create(tx, ctx, body));
  }

  @Get('imports/:id')
  get(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(IdParam)) p: Id,
  ) {
    return this.run(t, req, async (tx, ctx) =>
      this.imports.one(tx, await this.imports.load(tx, ctx, p.id)),
    );
  }

  /** Reads the file between two short transactions, never inside one. */
  @Post('imports/:id/analyse')
  @HttpCode(200)
  async analyse(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(IdParam)) p: Id,
    @Body(new ZodPipe(AnalyseImportRequest)) body: Out<typeof AnalyseImportRequest>,
  ) {
    this.imports.requireStorage();
    const job = await this.run(t, req, (tx, ctx) => this.imports.configurable(tx, ctx, p.id));
    const read = await this.imports.read(job, body);
    return this.run(t, req, async (tx, ctx) =>
      this.imports.analysed(
        tx,
        ctx,
        await this.imports.configurable(tx, ctx, p.id, job.version),
        read,
      ),
    );
  }

  @Patch('imports/:id')
  update(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(IdParam)) p: Id,
    @Body(new ZodPipe(UpdateImportRequest)) body: Out<typeof UpdateImportRequest>,
  ) {
    return this.run(t, req, (tx, ctx) => this.imports.update(tx, ctx, p.id, body));
  }

  @Post('imports/:id/dry-run')
  @HttpCode(202)
  dryRun(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(IdParam)) p: Id,
  ) {
    return this.run(t, req, (tx, ctx) => this.imports.dryRun(tx, ctx, p.id));
  }

  @Post('imports/:id/start')
  @HttpCode(202)
  start(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(IdParam)) p: Id,
  ) {
    return this.run(t, req, (tx, ctx) => this.imports.start(tx, ctx, p.id));
  }

  @Post('imports/:id/cancel')
  @HttpCode(200)
  async cancel(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(IdParam)) p: Id,
  ) {
    const { dto, fileKey } = await this.run(t, req, (tx, ctx) =>
      this.imports.cancel(tx, ctx, p.id),
    );
    await this.imports.discard(fileKey);
    return dto;
  }

  @Post('imports/:id/undo')
  @HttpCode(202)
  undo(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(IdParam)) p: Id,
  ) {
    return this.run(t, req, (tx, ctx) => this.imports.undo(tx, ctx, p.id));
  }

  @Get('imports/:id/rows')
  rows(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(IdParam)) p: Id,
    @Query(new ZodPipe(ImportRowsQuery)) q: Out<typeof ImportRowsQuery>,
  ) {
    return this.run(t, req, (tx, ctx) => this.imports.rows(tx, ctx, p.id, q));
  }

  @Get('imports/:id/results')
  results(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(IdParam)) p: Id,
  ) {
    return this.run(t, req, (tx, ctx) => this.imports.results(tx, ctx, p.id));
  }

  @Get('import-templates')
  templates(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Query(new ZodPipe(TemplatesQuery)) q: Out<typeof TemplatesQuery>,
  ) {
    return this.run(t, req, (tx, ctx) => this.imports.templates(tx, ctx, q.object));
  }

  @Post('import-templates')
  createTemplate(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Body(new ZodPipe(CreateImportTemplateRequest)) body: Out<typeof CreateImportTemplateRequest>,
  ) {
    return this.run(t, req, (tx, ctx) => this.imports.createTemplate(tx, ctx, body));
  }

  @Delete('import-templates/:id')
  @HttpCode(204)
  async deleteTemplate(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(IdParam)) p: Id,
  ) {
    await this.run(t, req, (tx, ctx) => this.imports.deleteTemplate(tx, ctx, p.id));
  }
}
