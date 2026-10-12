import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import { Inject, Injectable } from '@nestjs/common';
import {
  type AnalyseImportRequest,
  type CreateImportRequest,
  type CreateImportTemplateRequest,
  type ImportColumnMapping,
  type ImportJobDto,
  type ImportRowDto,
  type ImportsQuery,
  type UpdateImportRequest,
} from '@sm/contracts';
import { audit, outbox, type TenantTransaction } from '@sm/db';
import { serverTranslator } from '@sm/i18n';
import {
  headersSignature,
  IMPORT_DRY_RUN_TOPIC,
  IMPORT_RUN_TOPIC,
  IMPORT_UNDO_TOPIC,
  readRows,
  suggestMappings,
  UNDO_HOURS,
  undoable,
  xlsxSheets,
  type FileType,
} from '@sm/imports';
import { storageKey, type StorageProvider } from '@sm/integrations';
import type { ObjectMeta } from '@sm/metadata';
import { fieldAccess, hasSystemPermission, objectAccess } from '@sm/permissions';
import type { RecordContext } from '@sm/records';
import { DomainError, errors } from '@sm/server-kit';
import type { z } from 'zod';

import { isWritable } from '../metadata/metadata.service.js';
import { invalid, isUniqueViolation, nameTaken, staleVersion } from '../setup/common.js';
import { STORAGE } from '../tokens.js';

type Job = Awaited<ReturnType<TenantTransaction['prisma']['importJob']['findFirst']>> & {};
type Mapping = z.infer<typeof ImportColumnMapping>;
type Dto = z.infer<typeof ImportJobDto>;

const CONTENT_TYPES: Record<FileType, string> = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const UPLOAD_SECONDS = 15 * 60;
const DOWNLOAD_SECONDS = 5 * 60;
const SAMPLE_ROWS = 5;
/** Still being configured: mapping, dry run, start and cancel apply. */
const CONFIGURABLE = new Set(['UPLOADED', 'READY']);

const iso = (d: Date | null) => d?.toISOString() ?? null;
const localeOf = (ctx: RecordContext): string => {
  const locale = ctx.globals('User', 'locale');
  return typeof locale === 'string' ? locale : 'en';
};
const notConfigurable = () => errors.conflict('This import has already been started');

/**
 * Data import (§7.1, P03 T18). Jobs belong to the user who started them: only they configure,
 * start, cancel and undo it (the worker runs it as them); Setup viewers can read everyone's.
 */
@Injectable()
export class ImportsService {
  constructor(@Inject(STORAGE) private readonly storage: StorageProvider | null) {}

  /** Object storage, or 503 when this cell has none configured. */
  requireStorage(): StorageProvider {
    if (!this.storage)
      throw new DomainError('service_unavailable', 503, 'File storage is not configured');
    return this.storage;
  }

  /** An object the caller may import into: readable (else 404) and creatable (else 403). */
  importable(ctx: RecordContext, objectName: string): ObjectMeta {
    const object = ctx.metadata.object(objectName);
    const access = objectAccess(ctx.permissions, objectName);
    if (!object || !access.read) throw errors.notFound('Object');
    if (!access.create) throw errors.forbidden('You cannot create records of this object');
    return object;
  }

  /** The job, as the caller may see it: their own, or anyone's for a Setup viewer (read only). */
  async load(tx: TenantTransaction, ctx: RecordContext, id: string, write = false): Promise<Job> {
    const job = await tx.prisma.importJob.findFirst({ where: { id } });
    if (!job) throw errors.notFound('Import');
    if (job.createdBy === ctx.userId) return job;
    if (!hasSystemPermission(ctx.permissions, 'view_setup')) throw errors.notFound('Import');
    if (write) throw errors.forbidden('Only the user who started an import can change it');
    return job;
  }

  /** The caller's job while it can still be configured (and unchanged since `version`). */
  async configurable(
    tx: TenantTransaction,
    ctx: RecordContext,
    id: string,
    version?: number,
  ): Promise<Job> {
    const job = await this.load(tx, ctx, id, true);
    if (!CONFIGURABLE.has(job.status)) throw notConfigurable();
    if (version !== undefined && job.version !== version) throw staleVersion('import');
    return job;
  }

  async dto(tx: TenantTransaction, jobs: Job[]): Promise<Dto[]> {
    const userIds = [...new Set(jobs.flatMap((j) => (j.createdBy ? [j.createdBy] : [])))];
    const users = userIds.length
      ? await tx.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true },
        })
      : [];
    const names = new Map(users.map((u) => [u.id, u.name]));
    const now = new Date();
    return jobs.map((j) => ({
      id: j.id,
      object: j.object,
      status: j.status,
      fileName: j.fileName,
      fileSize: Number(j.fileSize),
      fileType: j.fileType as FileType,
      sheet: j.sheet,
      headerRow: j.headerRow,
      headers: j.headers,
      mapping: j.mapping as Mapping[],
      duplicateMode: j.duplicateMode,
      matchingRuleId: j.matchingRuleId,
      runAssignment: j.runAssignment,
      assignmentRuleId: j.assignmentRuleId,
      defaults: j.defaults as Dto['defaults'],
      dryRun: j.dryRun as Dto['dryRun'],
      total: j.total,
      processed: j.processed,
      created: j.created,
      updated: j.updated,
      skipped: j.skipped,
      failed: j.failed,
      error: j.error,
      hasResults: j.resultFileKey !== null,
      undoableUntil:
        undoable(j, now) && j.finishedAt
          ? new Date(j.finishedAt.getTime() + UNDO_HOURS * 3_600_000).toISOString()
          : null,
      startedAt: iso(j.startedAt),
      finishedAt: iso(j.finishedAt),
      undoneAt: iso(j.undoneAt),
      createdAt: j.createdAt.toISOString(),
      createdBy: j.createdBy ? { id: j.createdBy, name: names.get(j.createdBy) ?? '' } : null,
      version: j.version,
    }));
  }

  async one(tx: TenantTransaction, job: Job): Promise<Dto> {
    const [dto] = await this.dto(tx, [job]);
    if (!dto) throw errors.notFound('Import');
    return dto;
  }

  async list(tx: TenantTransaction, ctx: RecordContext, q: z.output<typeof ImportsQuery>) {
    const everyone = hasSystemPermission(ctx.permissions, 'view_setup') && q.mine !== true;
    const jobs = await tx.prisma.importJob.findMany({
      where: {
        ...(everyone ? {} : { createdBy: ctx.userId }),
        ...(q.object ? { object: q.object } : {}),
        ...(q.status ? { status: q.status } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit,
    });
    return { items: await this.dto(tx, jobs) };
  }

  async create(
    tx: TenantTransaction,
    ctx: RecordContext,
    body: z.output<typeof CreateImportRequest>,
  ) {
    const files = this.requireStorage();
    const object = this.importable(ctx, body.object);
    const fileKey = storageKey(tx.context.tenantId, randomUUID());
    const job = await tx.prisma.importJob.create({
      data: {
        tenantId: tx.context.tenantId,
        object: object.apiName,
        fileName: body.fileName,
        fileKey,
        fileSize: BigInt(body.fileSize),
        fileType: body.fileType,
        createdBy: ctx.userId,
      },
    });
    const contentType = CONTENT_TYPES[body.fileType];
    const url = await files.presignPut(fileKey, contentType, body.fileSize, UPLOAD_SECONDS);
    return {
      job: await this.one(tx, job),
      upload: {
        url,
        method: 'PUT' as const,
        headers: { 'content-type': contentType },
        expiresAt: new Date(Date.now() + UPLOAD_SECONDS * 1000).toISOString(),
      },
    };
  }

  /** The uploaded file as a stream; 409 while it has not arrived. */
  private async open(job: Job): Promise<Readable> {
    try {
      return await this.requireStorage().getObject(job.fileKey);
    } catch (err) {
      if (err instanceof DomainError) throw err;
      throw errors.conflict('The file has not been uploaded yet');
    }
  }

  /**
   * Read the file (outside any transaction): sheets, the header row and a sample. Unreadable
   * files are validation errors on `file`; a sheet that does not exist one on `sheet`.
   */
  async read(job: Job, body: z.output<typeof AnalyseImportRequest>) {
    const type = job.fileType as FileType;
    const headerRow = body.headerRow ?? job.headerRow;
    const fail = (err: unknown): never => {
      const message = err instanceof Error ? err.message : String(err);
      if (/no sheet/.test(message)) throw invalid('sheet', 'No such sheet', 'invalid_reference');
      throw invalid('file', 'The file cannot be read as ' + type.toUpperCase(), 'unreadable_file');
    };
    let sheets: string[] = [];
    if (type === 'xlsx') sheets = await xlsxSheets(await this.open(job)).catch(fail);
    const sheet = type === 'xlsx' ? (body.sheet ?? job.sheet ?? sheets[0] ?? null) : null;
    const stream = await this.open(job);
    const rows: string[][] = [];
    try {
      for await (const cells of readRows(stream, type, sheet)) {
        rows.push(cells);
        if (rows.length >= headerRow + SAMPLE_ROWS) break;
      }
    } catch (err) {
      fail(err);
    } finally {
      stream.destroy();
    }
    const headers = (rows[headerRow - 1] ?? []).map((h) => h.trim());
    if (headers.every((h) => h === ''))
      throw invalid('headerRow', 'That row has no column headers', 'no_headers');
    const width = headers.length;
    const sample = rows
      .slice(headerRow)
      .map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ''));
    return { sheets, sheet, headerRow, headers, sample };
  }

  /** Field labels in the caller's language, for matching headers. */
  private labels(ctx: RecordContext, object: ObjectMeta): Record<string, string> {
    const t = serverTranslator(localeOf(ctx)) as unknown as (key: string) => string;
    return Object.fromEntries(
      object.fields.map((f) => [f.apiName, f.label ?? (f.labelKey ? t(f.labelKey) : f.apiName)]),
    );
  }

  private editable(ctx: RecordContext, object: ObjectMeta, field: string): boolean {
    const f = object.fields.find((x) => x.apiName === field);
    return !!f && isWritable(f) && fieldAccess(ctx.permissions, object.apiName, f.apiName, f).edit;
  }

  /**
   * Store what the file holds and suggest a mapping: the caller's last import of a file with the
   * same headers first, else API names, labels and synonyms (fields they can edit only).
   */
  async analysed(
    tx: TenantTransaction,
    ctx: RecordContext,
    job: Job,
    read: Awaited<ReturnType<ImportsService['read']>>,
  ) {
    const object = this.importable(ctx, job.object);
    const signature = headersSignature(read.headers);
    const sameLayout = headersSignature(job.headers) === signature && job.sheet === read.sheet;
    const updated = await tx.prisma.importJob.update({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id: job.id } },
      data: {
        status: 'UPLOADED',
        sheet: read.sheet,
        headerRow: read.headerRow,
        headers: read.headers,
        ...(sameLayout ? {} : { mapping: [] }),
        version: { increment: 1 },
      },
    });
    await this.clearDryRun(tx, job.id);
    const previous = (
      await tx.prisma.importJob.findMany({
        where: {
          object: job.object,
          createdBy: ctx.userId,
          id: { not: job.id },
          status: { in: ['COMPLETED', 'UNDONE'] },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { headers: true, mapping: true },
      })
    ).find((p) => headersSignature(p.headers) === signature);
    const usable = (m: Mapping) =>
      m.column < read.headers.length &&
      (m.field === 'currency_code' || this.editable(ctx, object, m.field));
    const suggestions = previous
      ? (previous.mapping as Mapping[]).filter(usable)
      : suggestMappings(object, read.headers, this.labels(ctx, object)).filter(usable);
    const templates = await tx.prisma.importMappingTemplate.findMany({
      where: { object: job.object, headersSignature: signature },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    return {
      job: await this.one(tx, { ...updated, dryRun: null }),
      sheets: read.sheets,
      headers: read.headers,
      sample: read.sample,
      suggestions,
      templates,
    };
  }

  /** Every way a mapping can be wrong, as field errors (`mapping.{i}.{key}`). */
  private mappingErrors(
    ctx: RecordContext,
    object: ObjectMeta,
    mapping: readonly Mapping[],
    width: number | null,
    path = 'mapping',
  ) {
    const out: { field: string; code: string; message: string }[] = [];
    const used = new Set<string>();
    for (const [i, m] of mapping.entries()) {
      const at = (k: string) => `${path}.${String(i)}.${k}`;
      if (width !== null && m.column >= width)
        out.push({ field: at('column'), code: 'out_of_range', message: 'No such column' });
      if (used.has(m.field))
        out.push({ field: at('field'), code: 'duplicate', message: 'Mapped twice' });
      used.add(m.field);
      if (m.field === 'currency_code') continue;
      const f = object.fields.find((x) => x.apiName === m.field);
      if (!f || !this.editable(ctx, object, m.field)) {
        out.push({ field: at('field'), code: 'not_editable', message: 'Not a field you can set' });
        continue;
      }
      if (m.values && f.type !== 'picklist' && f.type !== 'multi_picklist')
        out.push({ field: at('values'), code: 'not_applicable', message: 'Picklists only' });
      if (m.dateOrder && f.type !== 'date' && f.type !== 'datetime')
        out.push({ field: at('dateOrder'), code: 'not_applicable', message: 'Dates only' });
      if (m.phoneCountry && f.type !== 'phone')
        out.push({ field: at('phoneCountry'), code: 'not_applicable', message: 'Phones only' });
      if (m.ownerBy && m.field !== 'owner_id')
        out.push({ field: at('ownerBy'), code: 'not_applicable', message: 'Owner only' });
    }
    return out;
  }

  async update(
    tx: TenantTransaction,
    ctx: RecordContext,
    id: string,
    body: z.output<typeof UpdateImportRequest>,
  ) {
    const job = await this.load(tx, ctx, id, true);
    if (job.version !== body.version) throw staleVersion('import');
    if (!CONFIGURABLE.has(job.status)) throw notConfigurable();
    const object = this.importable(ctx, job.object);
    const problems = body.mapping
      ? this.mappingErrors(ctx, object, body.mapping, job.headers.length || null)
      : [];
    for (const field of Object.keys(body.defaults ?? {}))
      if (field !== 'currency_code' && !this.editable(ctx, object, field))
        problems.push({
          field: `defaults.${field}`,
          code: 'not_editable',
          message: 'Not a field you can set',
        });
    const matchingRuleId =
      body.matchingRuleId === undefined ? job.matchingRuleId : body.matchingRuleId;
    if (body.matchingRuleId) {
      const rule = await tx.prisma.matchingRule.findFirst({
        where: { id: body.matchingRuleId, object: job.object },
      });
      if (!rule)
        problems.push({
          field: 'matchingRuleId',
          code: 'invalid_reference',
          message: 'No such matching rule for this object',
        });
    }
    if (body.assignmentRuleId) {
      const rule = await tx.prisma.assignmentRule.findFirst({
        where: { id: body.assignmentRuleId, object: job.object },
      });
      if (!rule)
        problems.push({
          field: 'assignmentRuleId',
          code: 'invalid_reference',
          message: 'No such assignment rule for this object',
        });
    }
    const mode = body.duplicateMode ?? job.duplicateMode;
    if (mode !== 'CREATE' && body.duplicateMode && !matchingRuleId)
      problems.push({
        field: 'matchingRuleId',
        code: 'required',
        message: 'Skipping or updating duplicates needs a matching rule',
      });
    if (problems.length) throw errors.validation(problems);
    const updated = await tx.prisma.importJob.update({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
      data: {
        status: 'UPLOADED',
        ...(body.mapping ? { mapping: body.mapping } : {}),
        ...(body.duplicateMode ? { duplicateMode: body.duplicateMode } : {}),
        ...(body.matchingRuleId !== undefined ? { matchingRuleId: body.matchingRuleId } : {}),
        ...(body.runAssignment !== undefined ? { runAssignment: body.runAssignment } : {}),
        ...(body.assignmentRuleId !== undefined ? { assignmentRuleId: body.assignmentRuleId } : {}),
        ...(body.defaults ? { defaults: body.defaults } : {}),
        version: { increment: 1 },
      },
    });
    // Any change makes an earlier dry run stale.
    await this.clearDryRun(tx, id);
    return this.one(tx, { ...updated, dryRun: null });
  }

  /** A JSON column to SQL NULL (Prisma would need its DbNull sentinel). */
  private async clearDryRun(tx: TenantTransaction, id: string) {
    await tx.prisma.$executeRaw`UPDATE import_job SET dry_run = NULL
      WHERE tenant_id = ${tx.context.tenantId}::uuid AND id = ${id}::uuid`;
  }

  /** Ready to run: configurable, analysed and mapped. */
  private assertRunnable(job: Job) {
    if (!CONFIGURABLE.has(job.status)) throw notConfigurable();
    if (job.headers.length === 0 || (job.mapping as Mapping[]).length === 0)
      throw invalid('mapping', 'Map at least one column first', 'required');
  }

  async dryRun(tx: TenantTransaction, ctx: RecordContext, id: string) {
    this.requireStorage();
    const job = await this.load(tx, ctx, id, true);
    this.assertRunnable(job);
    const updated = await tx.prisma.importJob.update({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
      data: { status: 'UPLOADED', version: { increment: 1 } },
    });
    await this.clearDryRun(tx, id);
    await outbox.emit(tx, {
      topic: IMPORT_DRY_RUN_TOPIC,
      aggregateType: 'import_job',
      aggregateId: id,
      payload: { jobId: id },
    });
    return this.one(tx, { ...updated, dryRun: null });
  }

  async start(tx: TenantTransaction, ctx: RecordContext, id: string) {
    this.requireStorage();
    const job = await this.load(tx, ctx, id, true);
    this.assertRunnable(job);
    this.importable(ctx, job.object);
    const updated = await tx.prisma.importJob.update({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
      data: { status: 'QUEUED', version: { increment: 1 } },
    });
    await outbox.emit(tx, {
      topic: IMPORT_RUN_TOPIC,
      aggregateType: 'import_job',
      aggregateId: id,
      payload: { jobId: id },
    });
    await audit.setup(tx, {
      action: 'import.started',
      entityType: 'import_job',
      entityId: id,
      entityName: job.fileName,
      after: { object: job.object, duplicateMode: job.duplicateMode },
    });
    return this.one(tx, updated);
  }

  /** Cancel before the worker picks it up; the file is deleted after the transaction. */
  async cancel(tx: TenantTransaction, ctx: RecordContext, id: string) {
    const job = await this.load(tx, ctx, id, true);
    const n = await tx.prisma.importJob.updateMany({
      where: { id, status: { in: ['UPLOADED', 'READY', 'QUEUED'] } },
      data: { status: 'CANCELLED', finishedAt: new Date(), version: { increment: 1 } },
    });
    if (n.count === 0) throw notConfigurable();
    const updated = await this.load(tx, ctx, id);
    return { dto: await this.one(tx, updated), fileKey: job.fileKey };
  }

  /** Delete a cancelled import's file; storage hiccups never fail the request. */
  async discard(fileKey: string): Promise<void> {
    await this.storage?.delete(fileKey).catch(() => undefined);
  }

  async undo(tx: TenantTransaction, ctx: RecordContext, id: string) {
    this.requireStorage();
    const job = await this.load(tx, ctx, id, true);
    if (!undoable(job))
      throw errors.conflict('Only completed imports can be undone, within 72 hours');
    const n = await tx.prisma.importJob.updateMany({
      where: { id, status: 'COMPLETED' },
      data: { status: 'UNDOING', version: { increment: 1 } },
    });
    if (n.count === 0) throw errors.conflict('This import is already being undone');
    await outbox.emit(tx, {
      topic: IMPORT_UNDO_TOPIC,
      aggregateType: 'import_job',
      aggregateId: id,
      payload: { jobId: id },
    });
    await audit.setup(tx, {
      action: 'import.undone',
      entityType: 'import_job',
      entityId: id,
      entityName: job.fileName,
      after: { object: job.object, created: job.created },
    });
    return this.one(tx, await this.load(tx, ctx, id));
  }

  async results(tx: TenantTransaction, ctx: RecordContext, id: string) {
    const files = this.requireStorage();
    const job = await this.load(tx, ctx, id);
    if (!job.resultFileKey) throw errors.conflict('This import has no results file yet');
    return {
      url: await files.presignGet(job.resultFileKey, DOWNLOAD_SECONDS),
      expiresAt: new Date(Date.now() + DOWNLOAD_SECONDS * 1000).toISOString(),
    };
  }

  async rows(
    tx: TenantTransaction,
    ctx: RecordContext,
    id: string,
    q: {
      status?: 'CREATED' | 'UPDATED' | 'SKIPPED' | 'FAILED' | undefined;
      after?: number | undefined;
      limit: number;
    },
  ): Promise<{ items: z.infer<typeof ImportRowDto>[]; next: number | null }> {
    await this.load(tx, ctx, id);
    const rows = await tx.prisma.importRowResult.findMany({
      where: {
        importJobId: id,
        ...(q.status ? { status: q.status } : {}),
        ...(q.after !== undefined ? { rowNumber: { gt: q.after } } : {}),
      },
      orderBy: { rowNumber: 'asc' },
      take: q.limit + 1,
    });
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((r) => ({
        row: r.rowNumber,
        status: r.status,
        recordId: r.recordId,
        errors: ((r.errors ?? []) as { field: string; code: string }[]).map((e) => ({
          field: e.field,
          code: e.code,
        })),
      })),
      next: rows.length > q.limit ? (page.at(-1)?.rowNumber ?? null) : null,
    };
  }

  // ── Mapping templates ─────────────────────────────────────────────────────

  async templates(tx: TenantTransaction, ctx: RecordContext, object?: string) {
    const rows = await tx.prisma.importMappingTemplate.findMany({
      where: object ? { object } : {},
      orderBy: [{ object: 'asc' }, { name: 'asc' }],
      take: 500,
    });
    return {
      items: rows
        .filter((r) => objectAccess(ctx.permissions, r.object).read)
        .map((r) => this.templateDto(r)),
    };
  }

  private templateDto(r: {
    id: string;
    object: string;
    name: string;
    headersSignature: string;
    mapping: unknown;
    createdAt: Date;
  }) {
    return {
      id: r.id,
      object: r.object,
      name: r.name,
      headers: r.headersSignature,
      mapping: r.mapping as Mapping[],
      createdAt: r.createdAt.toISOString(),
    };
  }

  async createTemplate(
    tx: TenantTransaction,
    ctx: RecordContext,
    body: z.output<typeof CreateImportTemplateRequest>,
  ) {
    const object = this.importable(ctx, body.object);
    const problems = this.mappingErrors(ctx, object, body.mapping, body.headers.length);
    if (problems.length) throw errors.validation(problems);
    try {
      const row = await tx.prisma.importMappingTemplate.create({
        data: {
          tenantId: tx.context.tenantId,
          object: object.apiName,
          name: body.name,
          headersSignature: headersSignature(body.headers),
          mapping: body.mapping,
          createdBy: ctx.userId,
        },
      });
      return this.templateDto(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
  }

  async deleteTemplate(tx: TenantTransaction, ctx: RecordContext, id: string) {
    const row = await tx.prisma.importMappingTemplate.findFirst({ where: { id } });
    if (!row || !objectAccess(ctx.permissions, row.object).read) throw errors.notFound('Template');
    // Anyone who imports into the object may tidy its templates; Setup sees who did.
    await tx.prisma.importMappingTemplate.delete({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
    });
  }
}
