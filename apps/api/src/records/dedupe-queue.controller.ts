import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  CreateDuplicateJobRequest,
  DuplicateCandidatesQuery,
  type DuplicateCandidateDto,
  type DuplicateJobDto,
} from '@sm/contracts';
import {
  audit,
  outbox,
  withTenant,
  type CellPrisma,
  type TenantContext,
  type TenantTransaction,
} from '@sm/db';
import type { ObjectMeta } from '@sm/metadata';
import { objectAccess } from '@sm/permissions';
import { sharingPredicate } from '@sm/query-engine';
import { DUPLICATE_SCAN_TOPIC, RecordError, type RecordContext } from '@sm/records';
import { errors, ZodPipe } from '@sm/server-kit';
import type { FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';

import {
  RequireSystemPermission,
  SystemPermissionGuard,
} from '../access/system-permission.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentTenant, TenantContextGuard } from '../tenancy/tenant-context.guard.js';
import { PRISMA } from '../tokens.js';
import { DuplicatesService } from './duplicates.service.js';
import { RecordContextService } from './record-context.service.js';
import { translating } from './record-errors.js';

type Job = z.infer<typeof DuplicateJobDto>;
type Candidate = z.infer<typeof DuplicateCandidateDto>;
const IdParam = z.object({ id: z.uuid() });

const iso = (d: Date | null) => d?.toISOString() ?? null;

/** Setup → Duplicate jobs (§7.2): tenant-wide scans feeding the review queue. */
@Controller('v1/duplicate-jobs')
@UseGuards(AuthGuard, TenantContextGuard, SystemPermissionGuard)
@RequireSystemPermission('view_setup')
export class DuplicateJobsController {
  constructor(@Inject(PRISMA) private readonly prisma: CellPrisma) {}

  private static dto(
    row: {
      id: string;
      object: string;
      schedule: string | null;
      status: Job['status'];
      scanned: number;
      found: number;
      startedAt: Date | null;
      finishedAt: Date | null;
      nextRunAt: Date | null;
      createdAt: Date;
      matchingRuleId: string;
    },
    ruleName: string,
  ): Job {
    return {
      id: row.id,
      object: row.object as Job['object'],
      matchingRule: { id: row.matchingRuleId, name: ruleName },
      schedule: row.schedule as Job['schedule'],
      status: row.status,
      scanned: row.scanned,
      found: row.found,
      startedAt: iso(row.startedAt),
      finishedAt: iso(row.finishedAt),
      nextRunAt: iso(row.nextRunAt),
      createdAt: row.createdAt.toISOString(),
    };
  }

  @Get()
  list(@CurrentTenant() t: TenantContext) {
    return withTenant(this.prisma, t, async (tx) => {
      const [jobs, rules] = await Promise.all([
        tx.prisma.duplicateJob.findMany({
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 200,
        }),
        tx.prisma.matchingRule.findMany({ select: { id: true, name: true } }),
      ]);
      const names = new Map(rules.map((r) => [r.id, r.name]));
      return {
        items: jobs.map((j) => DuplicateJobsController.dto(j, names.get(j.matchingRuleId) ?? '')),
      };
    });
  }

  @Post()
  @RequireSystemPermission('customize_application')
  create(
    @CurrentTenant() t: TenantContext,
    @Body(new ZodPipe(CreateDuplicateJobRequest)) body: z.output<typeof CreateDuplicateJobRequest>,
  ) {
    return withTenant(this.prisma, t, async (tx) => {
      const rule = await tx.prisma.matchingRule.findFirst({ where: { id: body.matchingRuleId } });
      if (!rule)
        throw errors.validation([
          { field: 'matchingRuleId', code: 'invalid_reference', message: 'No such matching rule' },
        ]);
      const job = await tx.prisma.duplicateJob.create({
        data: {
          tenantId: tx.context.tenantId,
          object: rule.object,
          matchingRuleId: rule.id,
          schedule: body.schedule,
          createdBy: tx.context.userId ?? null,
        },
      });
      await outbox.emit(tx, {
        topic: DUPLICATE_SCAN_TOPIC,
        aggregateType: 'duplicate_job',
        aggregateId: job.id,
        payload: { jobId: job.id },
      });
      await audit.setup(tx, {
        action: 'duplicate_job.created',
        entityType: 'duplicate_job',
        entityId: job.id,
        entityName: rule.name,
        after: { object: rule.object, matchingRuleId: rule.id, schedule: body.schedule },
      });
      return DuplicateJobsController.dto(job, rule.name);
    });
  }
}

/**
 * The review queue (§7.2): groups found by duplicate jobs. A user sees a group only when they can
 * see every record in it (sharing), and merges it with `POST /v1/records/{object}/merge`.
 */
@Controller('v1/duplicate-candidates')
@UseGuards(AuthGuard, TenantContextGuard)
export class DuplicateCandidatesController {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly contexts: RecordContextService,
    private readonly duplicates: DuplicatesService,
  ) {}

  private run<T>(
    t: TenantContext,
    request: FastifyRequest,
    fn: (tx: TenantTransaction, ctx: RecordContext) => Promise<T>,
  ) {
    return withTenant(this.prisma, t, async (tx) =>
      translating(async () => fn(tx, await this.contexts.forCaller(tx, request.id))),
    );
  }

  /** Groups whose records the caller can all see (live ones only while the group is open). */
  private async visibleGroups(
    tx: TenantTransaction,
    ctx: RecordContext,
    object: ObjectMeta,
    where: { status?: string; id?: string; after?: { score: string; id: string } | undefined },
    limit: number,
  ) {
    const tenantId = tx.context.tenantId;
    return sql<{
      id: string;
      score: string;
      status: Candidate['status'];
      record_ids: string[];
      job_id: string | null;
      created_at: Date;
    }>`
      SELECT c.id, c.score::text AS score, c.status, c.record_ids::text[] AS record_ids,
        c.job_id, c.created_at
      FROM duplicate_candidate c
      WHERE c.tenant_id = ${tenantId}::uuid AND c.object = ${object.apiName}
        ${where.status ? sql`AND c.status = ${where.status}::duplicate_candidate_status` : sql``}
        ${where.id ? sql`AND c.id = ${where.id}::uuid` : sql``}
        ${where.after ? sql`AND (c.score, c.id) < (${where.after.score}::numeric, ${where.after.id}::uuid)` : sql``}
        AND NOT EXISTS (
          SELECT 1 FROM unnest(c.record_ids) AS x(id)
          WHERE NOT EXISTS (
            SELECT 1 FROM ${sql.table(object.table)} AS r
            WHERE r.tenant_id = c.tenant_id AND r.id = x.id
              AND (c.status <> 'OPEN' OR r.deleted_at IS NULL)
              AND ${sharingPredicate(ctx.sharing, object.apiName, 'r', 'read')}))
      ORDER BY c.score DESC, c.id DESC
      LIMIT ${limit}`.execute(tx.kysely);
  }

  private async toDtos(
    tx: TenantTransaction,
    ctx: RecordContext,
    object: ObjectMeta,
    rows: Awaited<ReturnType<DuplicateCandidatesController['visibleGroups']>>['rows'],
  ): Promise<Candidate[]> {
    const names = await this.duplicates.names(tx, ctx, object, [
      ...new Set(rows.flatMap((r) => r.record_ids)),
    ]);
    return rows.map((r) => ({
      id: r.id,
      object: object.apiName as Candidate['object'],
      score: Number(r.score),
      status: r.status,
      records: r.record_ids.map((id) => ({ id, name: names.get(id) ?? null })),
      jobId: r.job_id,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  @Get()
  list(
    @CurrentTenant() t: TenantContext,
    @Req() request: FastifyRequest,
    @Query(new ZodPipe(DuplicateCandidatesQuery)) q: z.output<typeof DuplicateCandidatesQuery>,
  ) {
    return this.run(t, request, async (tx, ctx) => {
      const object = this.duplicates.objectFor(ctx, q.object);
      const [score, id] = q.cursor?.split('|') ?? [];
      if (
        q.cursor &&
        (!score || !/^\d+(\.\d+)?$/.test(score) || !id || !z.uuid().safeParse(id).success)
      )
        throw errors.validation([{ field: 'cursor', code: 'invalid', message: 'Invalid cursor' }]);
      const rows = (
        await this.visibleGroups(
          tx,
          ctx,
          object,
          { status: q.status, after: score && id ? { score, id } : undefined },
          q.limit + 1,
        )
      ).rows;
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return {
        items: await this.toDtos(tx, ctx, object, page),
        nextCursor: rows.length > q.limit && last ? `${last.score}|${last.id}` : null,
      };
    });
  }

  @Post(':id/dismiss')
  @HttpCode(200)
  dismiss(
    @CurrentTenant() t: TenantContext,
    @Req() request: FastifyRequest,
    @Param(new ZodPipe(IdParam)) p: z.infer<typeof IdParam>,
  ) {
    return this.run(t, request, async (tx, ctx) => {
      const found = await tx.prisma.duplicateCandidate.findFirst({ where: { id: p.id } });
      if (!found) throw new RecordError('not_found');
      const object = this.duplicates.objectFor(ctx, found.object);
      const [row] = (await this.visibleGroups(tx, ctx, object, { id: p.id }, 1)).rows;
      if (!row) throw new RecordError('not_found');
      if (!objectAccess(ctx.permissions, object.apiName).edit) throw new RecordError('forbidden');
      if (row.status !== 'OPEN')
        throw new RecordError('conflict', [{ field: '_record', code: 'already_resolved' }]);
      await tx.prisma.duplicateCandidate.update({
        where: { tenantId_id: { tenantId: tx.context.tenantId, id: p.id } },
        data: { status: 'DISMISSED', resolvedAt: new Date(), resolvedBy: ctx.userId },
      });
      await audit.record(tx, {
        action: 'duplicate.dismissed',
        object: object.apiName,
        ...(row.record_ids[0] ? { recordId: row.record_ids[0] } : {}),
        payload: { candidateId: p.id, recordIds: row.record_ids },
        ...(request.id ? { requestId: request.id } : {}),
      });
      const [dto] = await this.toDtos(tx, ctx, object, [{ ...row, status: 'DISMISSED' }]);
      return dto;
    });
  }
}
