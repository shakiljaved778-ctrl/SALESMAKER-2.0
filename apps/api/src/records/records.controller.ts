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
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ExternalIdParam,
  GetRecordQuery,
  IfMatchHeaders,
  ListRecordsQuery,
  MassActionRequest,
  ObjectParam,
  OptionalIdempotencyHeaders,
  PutTeamMemberRequest,
  QueryRequest,
  RecentItemsQuery,
  RecordParam,
  SearchQuery,
  TeamMemberParam,
  TeamObjectParam,
  WriteFieldsRequest,
} from '@sm/contracts';
import { withTenant, type CellPrisma, type TenantContext, type TenantTransaction } from '@sm/db';
import type { RecordContext } from '@sm/records';
import { ZodPipe } from '@sm/server-kit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentTenant, TenantContextGuard } from '../tenancy/tenant-context.guard.js';
import { PRISMA } from '../tokens.js';
import { IdempotencyService } from './idempotency.service.js';
import { RecordContextService } from './record-context.service.js';
import { RecordsService } from './records.service.js';

type Obj = z.infer<typeof ObjectParam>;
type Rec = z.infer<typeof RecordParam>;
type Team = z.infer<typeof TeamObjectParam>;
type Member = z.infer<typeof TeamMemberParam>;
type Write = z.infer<typeof WriteFieldsRequest>;
type Mass = z.infer<typeof MassActionRequest>;
const JobParam = z.object({ id: z.uuid() });

/** `If-Match: 3`, `"3"` or `W/"3"` → 3. */
const versionOf = (headers: Record<string, unknown>): number | null => {
  const value = IfMatchHeaders.parse(headers)['if-match'];
  return value === undefined ? null : Number(value.replace(/\D/g, ''));
};

/**
 * The records API (§10.1). Access is decided per object, record and field by RecordService and
 * the Query Engine, so these routes need only an authenticated caller in a workspace.
 */
@Controller('v1')
@UseGuards(AuthGuard, TenantContextGuard)
export class RecordsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly contexts: RecordContextService,
    private readonly records: RecordsService,
    private readonly idempotency: IdempotencyService,
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

  private static locale(ctx: RecordContext): string {
    const locale = ctx.globals('User', 'locale');
    return typeof locale === 'string' ? locale : 'en';
  }

  @Get('objects')
  listObjects(@CurrentTenant() t: TenantContext, @Req() req: FastifyRequest) {
    return this.run(t, req, (_tx, ctx) =>
      Promise.resolve(this.records.listObjects(ctx, RecordsController.locale(ctx))),
    );
  }

  @Get('objects/:object/describe')
  describeObject(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(ObjectParam)) p: Obj,
  ) {
    return this.run(t, req, (_tx, ctx) =>
      Promise.resolve(this.records.describe(ctx, p.object, RecordsController.locale(ctx))),
    );
  }

  @Get('records/:object')
  listRecords(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(ObjectParam)) p: Obj,
    @Query(new ZodPipe(ListRecordsQuery)) q: z.infer<typeof ListRecordsQuery>,
  ) {
    return this.run(t, req, (tx, ctx) => this.records.list(tx, ctx, p.object, q));
  }

  @Post('records/:object')
  @HttpCode(201)
  createRecord(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Headers() headers: Record<string, unknown>,
    @Param(new ZodPipe(ObjectParam)) p: Obj,
    @Body(new ZodPipe(WriteFieldsRequest)) body: Write,
  ) {
    const key = OptionalIdempotencyHeaders.parse(headers)['idempotency-key'];
    return this.run(t, req, (tx, ctx) =>
      this.idempotency.run(tx, key, { route: 'createRecord', object: p.object, body }, 201, () =>
        this.records.create(tx, ctx, p.object, body),
      ),
    );
  }

  @Get('records/:object/:id')
  getRecord(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(RecordParam)) p: Rec,
    @Query(new ZodPipe(GetRecordQuery)) q: z.infer<typeof GetRecordQuery>,
  ) {
    return this.run(t, req, (tx, ctx) => this.records.get(tx, ctx, p.object, p.id, q.fields));
  }

  @Patch('records/:object/:id')
  updateRecord(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Headers() headers: Record<string, unknown>,
    @Param(new ZodPipe(RecordParam)) p: Rec,
    @Body(new ZodPipe(WriteFieldsRequest)) body: Write,
  ) {
    const version = versionOf(headers);
    return this.run(t, req, (tx, ctx) =>
      this.records.update(tx, ctx, p.object, p.id, body, version),
    );
  }

  @Delete('records/:object/:id')
  @HttpCode(204)
  async deleteRecord(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(RecordParam)) p: Rec,
  ) {
    await this.run(t, req, (tx, ctx) => this.records.remove(tx, ctx, p.object, p.id));
  }

  @Put('records/:object/external/:externalId')
  async upsertRecord(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param(new ZodPipe(ExternalIdParam)) p: z.infer<typeof ExternalIdParam>,
    @Body(new ZodPipe(WriteFieldsRequest)) body: Write,
  ) {
    const { created, record } = await this.run(t, req, (tx, ctx) =>
      this.records.upsert(tx, ctx, p.object, p.externalId, body),
    );
    void reply.status(created ? 201 : 200);
    return record;
  }

  @Post('query')
  @HttpCode(200)
  query(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Body(new ZodPipe(QueryRequest)) body: z.infer<typeof QueryRequest>,
  ) {
    return this.run(t, req, (tx, ctx) => this.records.query(tx, ctx, body));
  }

  @Post('records/:object/mass/preview')
  @HttpCode(200)
  previewMassAction(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(ObjectParam)) p: Obj,
    @Body(new ZodPipe(MassActionRequest)) body: Mass,
  ) {
    return this.run(t, req, (tx, ctx) => this.records.previewMass(tx, ctx, p.object, body));
  }

  @Post('records/:object/mass')
  @HttpCode(202)
  startMassAction(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(ObjectParam)) p: Obj,
    @Body(new ZodPipe(MassActionRequest)) body: Mass,
  ) {
    return this.run(t, req, (tx, ctx) => this.records.startMass(tx, ctx, p.object, body));
  }

  @Get('jobs/:id')
  getJob(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(JobParam)) p: z.infer<typeof JobParam>,
  ) {
    return this.run(t, req, (tx, ctx) => this.records.job(tx, ctx, p.id));
  }

  @Get('records/:object/:id/team')
  listRecordTeam(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(TeamObjectParam)) p: Team,
  ) {
    return this.run(t, req, (tx, ctx) => this.records.team(tx, ctx, p.object, p.id));
  }

  @Put('records/:object/:id/team/:userId')
  putRecordTeamMember(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(TeamMemberParam)) p: Member,
    @Body(new ZodPipe(PutTeamMemberRequest)) body: z.infer<typeof PutTeamMemberRequest>,
  ) {
    return this.run(t, req, (tx, ctx) =>
      this.records.putTeamMember(tx, ctx, p.object, p.id, p.userId, body),
    );
  }

  @Delete('records/:object/:id/team/:userId')
  @HttpCode(204)
  async deleteRecordTeamMember(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(TeamMemberParam)) p: Member,
  ) {
    await this.run(t, req, (tx, ctx) =>
      this.records.removeTeamMember(tx, ctx, p.object, p.id, p.userId),
    );
  }

  @Get('search')
  search(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Query(new ZodPipe(SearchQuery)) q: z.infer<typeof SearchQuery>,
  ) {
    return this.run(t, req, (tx, ctx) => this.records.search(tx, ctx, q));
  }

  @Get('recent-items')
  listRecentItems(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Query(new ZodPipe(RecentItemsQuery)) q: z.infer<typeof RecentItemsQuery>,
  ) {
    return this.run(t, req, (tx, ctx) => this.records.recent(tx, ctx, q.limit));
  }

  @Post('records/:object/:id/viewed')
  @HttpCode(204)
  async recordViewed(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(RecordParam)) p: Rec,
  ) {
    await this.run(t, req, (tx, ctx) => this.records.viewed(tx, ctx, p.object, p.id));
  }

  @Get('recycle-bin')
  listRecycleBin(@CurrentTenant() t: TenantContext, @Req() req: FastifyRequest) {
    return this.run(t, req, (tx, ctx) => this.records.recycleBin(tx, ctx));
  }

  @Post('records/:object/:id/restore')
  @HttpCode(200)
  restoreRecord(
    @CurrentTenant() t: TenantContext,
    @Req() req: FastifyRequest,
    @Param(new ZodPipe(RecordParam)) p: Rec,
  ) {
    return this.run(t, req, (tx, ctx) => this.records.restore(tx, ctx, p.object, p.id));
  }
}
