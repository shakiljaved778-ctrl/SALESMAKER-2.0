import { audit, outbox, type TenantTransaction } from '@sm/db';
import { dateIn } from '@sm/formula';
import { normaliseValue, READ_ONLY_TYPES, type FieldMeta, type ObjectMeta } from '@sm/metadata';
import { fieldAccess, objectAccess } from '@sm/permissions';
import {
  evaluateRulesForRecord,
  sharingPredicate,
  type AccessLevel,
  type SharingRuleDefinition,
} from '@sm/query-engine';
import { sql } from 'kysely';

import type { RecordContext } from './context.js';
import { RecordError, type FieldError } from './errors.js';
import { hasMoney, ident, readStored, toColumns, type StoredRecord } from './storage.js';
import { runValidationRules } from './validation.js';

export interface WriteInput {
  /** Field API name → value (standard or custom). */
  fields: Record<string, unknown>;
  /** ISO-4217 currency of the record's money fields; defaults to the corporate currency. */
  currencyCode?: string;
}

export interface WriteResult {
  id: string;
  version: number;
  recordNumber: string | null;
  /** Fields whose stored value changed (all set fields on create). */
  changed: string[];
}

export interface WriteOptions {
  /** Lead conversion may write converted leads and set the converted status (T13). */
  conversion?: boolean;
}

const LOOKUPS = new Set(['lookup', 'master_detail', 'user']);
const OPPORTUNITY_TRACKED = ['stage', 'amount', 'close_date', 'forecast_category', 'probability'];
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const blank = (v: unknown) =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/** Whether the caller has `level` access to a live record (sharing, §6.4). */
async function hasAccess(
  tx: TenantTransaction,
  ctx: RecordContext,
  object: ObjectMeta,
  id: string,
  level: AccessLevel,
): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM ${sql.table(ident(object.table))} AS r
    WHERE r.tenant_id = ${tx.context.tenantId}::uuid AND r.id = ${id}::uuid AND r.deleted_at IS NULL
      AND ${sharingPredicate(ctx.sharing, object.apiName, 'r', level)}`.execute(tx.kysely);
  return rows.rows.length > 0;
}

function objectOf(ctx: RecordContext, name: string): ObjectMeta {
  const object = ctx.metadata.object(name);
  if (!object || !objectAccess(ctx.permissions, name).read) throw new RecordError('not_found');
  return object;
}

interface PipelineStage {
  apiValue: string;
  category: string;
  probability: string;
  forecastCategory: string;
}

async function pipelineStages(tx: TenantTransaction, pipelineId: string): Promise<PipelineStage[]> {
  const rows = await tx.prisma.pipelineStage.findMany({
    where: { pipelineId, active: true, pipeline: { active: true } },
    orderBy: { sortOrder: 'asc' },
  });
  return rows.map((s) => ({
    apiValue: s.apiValue,
    category: s.category,
    probability: s.probability.toString(),
    forecastCategory: s.forecastCategory,
  }));
}

/** Validate the caller's input fields: known, writable by type and by FLS, well-typed. */
function normaliseInput(
  ctx: RecordContext,
  object: ObjectMeta,
  input: Record<string, unknown>,
  recordTypeId: string | null,
): Record<string, unknown> {
  const invalid: FieldError[] = [];
  const forbidden: FieldError[] = [];
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(input)) {
    const f = ctx.metadata.field(object.apiName, name);
    if (!f) {
      invalid.push({ field: name, code: 'unknown_field' });
      continue;
    }
    if (f.system || READ_ONLY_TYPES.has(f.type)) {
      invalid.push({ field: name, code: 'read_only' });
      continue;
    }
    if (!fieldAccess(ctx.permissions, object.apiName, name, f).edit) {
      forbidden.push({ field: name, code: 'not_editable' });
      continue;
    }
    // Opportunity stages come from the pipeline, checked later; the rest from the picklist.
    const isStage = object.apiName === 'opportunity' && name === 'stage';
    const allowed = isStage
      ? undefined
      : f.type === 'picklist' || f.type === 'multi_picklist'
        ? ctx.metadata.picklistValues(object.apiName, name, recordTypeId).map((v) => v.apiValue)
        : undefined;
    const result = isStage
      ? typeof raw === 'string' || raw === null
        ? { ok: true as const, value: raw === '' ? null : raw }
        : { ok: false as const, code: 'invalid_type' }
      : normaliseValue(f, raw, allowed);
    if (!result.ok) invalid.push({ field: name, code: result.code });
    else out[name] = result.value;
  }
  if (forbidden.length) throw new RecordError('forbidden', forbidden);
  if (invalid.length) throw new RecordError('invalid', invalid);
  return out;
}

/** Defaults on create (§3.7 step 4): owner, record type, field defaults, default picklist values. */
function applyDefaults(
  ctx: RecordContext,
  object: ObjectMeta,
  values: Record<string, unknown>,
  given: ReadonlySet<string>,
): void {
  if (!given.has('owner_id') && object.fields.some((f) => f.apiName === 'owner_id'))
    values['owner_id'] = ctx.userId;
  const recordTypeId = (values['record_type_id'] as string | null | undefined) ?? null;
  for (const f of object.fields) {
    if (given.has(f.apiName) || f.system || READ_ONLY_TYPES.has(f.type)) continue;
    if (f.defaultValue !== null && f.defaultValue !== undefined) {
      const d = normaliseValue(f, f.defaultValue);
      if (d.ok) values[f.apiName] = d.value;
    } else if (
      f.type === 'picklist' &&
      !(object.apiName === 'opportunity' && f.apiName === 'stage')
    ) {
      const def = ctx.metadata
        .picklistValues(object.apiName, f.apiName, recordTypeId)
        .find((v) => v.isDefault);
      if (def) values[f.apiName] = def.apiValue;
    }
  }
}

async function checkReferences(
  tx: TenantTransaction,
  ctx: RecordContext,
  object: ObjectMeta,
  values: Record<string, unknown>,
  changed: ReadonlySet<string>,
): Promise<FieldError[]> {
  const errors: FieldError[] = [];
  const tenantId = tx.context.tenantId;
  for (const f of object.fields) {
    const id = values[f.apiName];
    if (!LOOKUPS.has(f.type) || !changed.has(f.apiName) || typeof id !== 'string') continue;
    let ok = false;
    if (f.apiName === 'owner_id') {
      const user = await tx.prisma.user.findFirst({
        where: { id, status: 'ACTIVE', deactivatedAt: null },
      });
      ok =
        Boolean(user) ||
        Boolean(
          await tx.prisma.queue.findFirst({
            where: { id, objects: { some: { object: object.apiName } } },
          }),
        );
    } else if (f.apiName === 'record_type_id') {
      ok = Boolean(
        await tx.prisma.recordType.findFirst({ where: { id, active: true, objectId: object.id } }),
      );
    } else if (f.referenceTo[0] === 'pipeline') {
      ok = Boolean(await tx.prisma.pipeline.findFirst({ where: { id, active: true } }));
    } else if (f.type === 'user' || f.referenceTo[0] === 'user') {
      ok = Boolean(await tx.prisma.user.findFirst({ where: { id } }));
    } else {
      for (const target of f.referenceTo) {
        const meta = ctx.metadata.object(target);
        if (!meta || !objectAccess(ctx.permissions, target).read) continue;
        const rows = await sql`
          SELECT 1 FROM ${sql.table(ident(meta.table))} AS r
          WHERE r.tenant_id = ${tenantId}::uuid AND r.id = ${id}::uuid AND r.deleted_at IS NULL
            AND ${sharingPredicate(ctx.sharing, target, 'r', 'read')}`.execute(tx.kysely);
        if (rows.rows.length) {
          ok = true;
          break;
        }
      }
    }
    if (!ok) errors.push({ field: f.apiName, code: 'invalid_reference' });
  }
  return errors;
}

/** Opportunity stage rules (§4.5): stage from the pipeline; probability, forecast, closed/won. */
async function applyStage(
  tx: TenantTransaction,
  values: Record<string, unknown>,
  given: ReadonlySet<string>,
  current: Record<string, unknown> | null,
): Promise<FieldError[]> {
  const pipelineId = values['pipeline_id'];
  if (typeof pipelineId !== 'string') return [];
  const stages = await pipelineStages(tx, pipelineId);
  if (values['stage'] === null || values['stage'] === undefined) {
    const first = stages.find((s) => s.category === 'OPEN');
    if (first) values['stage'] = first.apiValue;
  }
  const stage = stages.find((s) => s.apiValue === values['stage']);
  if (!stage) return [{ field: 'stage', code: 'not_in_pipeline' }];
  const stageChanged = !current || current['stage'] !== stage.apiValue;
  if (stageChanged) {
    if (!given.has('probability')) values['probability'] = Number(stage.probability).toFixed(2);
    if (!given.has('forecast_category')) values['forecast_category'] = stage.forecastCategory;
  }
  values['is_closed'] = stage.category !== 'OPEN';
  values['is_won'] = stage.category === 'WON';
  if (stage.category === 'LOST' && blank(values['loss_reason']))
    return [{ field: 'loss_reason', code: 'required' }];
  return [];
}

async function activeRules(
  tx: TenantTransaction,
  object: string,
): Promise<SharingRuleDefinition[]> {
  const rules = await tx.prisma.sharingRule.findMany({ where: { object, active: true } });
  return rules.map((r) => ({
    id: r.id,
    object: r.object,
    kind: r.kind,
    sourceType: r.sourceType,
    sourceId: r.sourceId,
    criteria: r.criteria,
    targetType: r.targetType,
    targetId: r.targetId,
    access: r.access,
    active: r.active,
  }));
}

/** The shared pipeline for create and update (§3.7 steps 1–8). */
async function write(
  tx: TenantTransaction,
  ctx: RecordContext,
  object: ObjectMeta,
  current: StoredRecord | null,
  input: WriteInput,
  options: WriteOptions,
): Promise<WriteResult> {
  const tenantId = tx.context.tenantId;
  const isNew = current === null;
  const recordTypeId =
    (input.fields['record_type_id'] as string | undefined) ??
    (current?.values['record_type_id'] as string | null | undefined) ??
    ctx.metadata.defaultRecordType(object.apiName)?.id ??
    null;
  const normalised = normaliseInput(ctx, object, input.fields, recordTypeId);
  const given = new Set(Object.keys(normalised));
  const values: Record<string, unknown> = { ...(current?.values ?? {}), ...normalised };
  if (isNew) {
    if (!given.has('record_type_id') && recordTypeId) values['record_type_id'] = recordTypeId;
    applyDefaults(ctx, object, values, given);
  }

  // Lead lifecycle: the converted status belongs to conversion (§4.4); converted leads are read-only.
  if (object.apiName === 'lead' && !options.conversion) {
    const status = ctx.metadata
      .field('lead', 'status')
      ?.picklistValues.find((v) => v.apiValue === values['status']);
    if (given.has('status') && status?.category === 'CONVERTED')
      throw new RecordError('unprocessable', [
        { field: 'status', code: 'converted_by_conversion' },
      ]);
  }

  const errors: FieldError[] = [];
  if (object.apiName === 'opportunity') {
    if (isNew && blank(values['pipeline_id'])) {
      const rt = object.recordTypes.find((r) => r.id === values['record_type_id']);
      const pipeline =
        rt?.pipelineId ??
        (await tx.prisma.pipeline.findFirst({ where: { isDefault: true } }))?.id ??
        null;
      if (pipeline) values['pipeline_id'] = pipeline;
    }
    errors.push(...(await applyStage(tx, values, given, current?.values ?? null)));
  }

  for (const f of object.fields)
    if (
      f.required &&
      !f.system &&
      blank(values[f.apiName]) &&
      !errors.some((e) => e.field === f.apiName)
    )
      errors.push({ field: f.apiName, code: 'required' });

  const changed = object.fields
    .map((f) => f.apiName)
    .filter((name) =>
      isNew
        ? values[name] !== undefined && values[name] !== null
        : !same(values[name], current.values[name]),
    );
  const changedSet = new Set(changed);
  errors.push(...(await checkReferences(tx, ctx, object, values, changedSet)));

  const money = hasMoney(object);
  const currencyCode = (
    input.currencyCode ??
    current?.currencyCode ??
    ctx.corporateCurrency
  ).toUpperCase();
  const currencyChanged = money && (isNew || currencyCode !== current.currencyCode);
  if (currencyChanged && !(await ctx.currency.isActive(currencyCode)))
    errors.push({ field: 'currency_code', code: 'inactive_currency' });
  if (errors.length) throw new RecordError('unprocessable', errors);

  await ctx.hooks?.beforeSave?.(object.apiName, values, isNew);
  await ctx.hooks?.duplicates?.(object.apiName, values, current?.id ?? null);
  const ruleErrors = await runValidationRules(tx, ctx, object, values, current?.values ?? null);
  if (ruleErrors.length) throw new RecordError('unprocessable', ruleErrors);

  // Corporate amounts (Q13): opportunity amount at the close date, other money on the day it is set.
  const extra: [string, unknown][] = [];
  if (money) {
    const today = dateIn(ctx.now?.() ?? new Date(), ctx.timezone);
    let rateDate: string | null = null;
    for (const f of object.fields.filter((x) => x.isStandard && x.type === 'currency')) {
      const isAmount = object.apiName === 'opportunity' && f.apiName === 'amount';
      const dateChanged = isAmount && changedSet.has('close_date');
      if (!(isNew || currencyChanged || changedSet.has(f.apiName) || dateChanged)) continue;
      const amount = values[f.apiName];
      let corporate: string | null = null;
      if (typeof amount === 'string') {
        const date =
          isAmount && typeof values['close_date'] === 'string' ? values['close_date'] : today;
        const converted = await ctx.currency.toCorporate(amount, currencyCode, date);
        corporate = converted?.amount ?? null;
        if (converted) rateDate = converted.rateDate;
      }
      extra.push([`${f.apiName}_corporate`, corporate]);
    }
    extra.push(['currency_code', currencyCode]);
    if (rateDate) extra.push(['corporate_rate_date', rateDate]);
  }

  const toWrite = isNew ? values : Object.fromEntries(changed.map((n) => [n, values[n]]));
  // Computed standard columns (is_closed, is_won) are system fields but written by the pipeline.
  if (object.apiName === 'opportunity')
    for (const n of ['is_closed', 'is_won', 'probability', 'forecast_category'])
      toWrite[n] = values[n];
  const { columns, custom } = toColumns(
    object,
    stripReadOnly(object, toWrite),
    current?.custom ?? {},
  );
  const assignments = [...columns, ...extra.map(([c, v]) => [ident(c), sql`${v}`] as const)];
  let id: string;
  let version: number;
  let recordNumber: string | null = null;
  if (isNew) {
    const auto = object.autoNumbers.find((a) => a.field === 'record_number');
    if (auto) {
      const rows = await sql<{
        n: string;
      }>`SELECT auto_number_next(${auto.fieldId}::uuid)::text AS n`.execute(tx.kysely);
      recordNumber = auto.format.replace(/\{(0+)\}/, (_, zeros: string) =>
        (rows.rows[0]?.n ?? '').padStart(zeros.length, '0'),
      );
    }
    const cols = [
      sql.ref('tenant_id'),
      ...assignments.map(([c]) => sql.ref(c)),
      sql.ref('custom'),
      sql.ref('created_by'),
      sql.ref('updated_by'),
      ...(recordNumber ? [sql.ref('record_number')] : []),
    ];
    const vals = [
      sql`${tenantId}::uuid`,
      ...assignments.map(([, v]) => v),
      sql`${JSON.stringify(custom)}::jsonb`,
      sql`${ctx.userId}::uuid`,
      sql`${ctx.userId}::uuid`,
      ...(recordNumber ? [sql`${recordNumber}`] : []),
    ];
    const rows = await sql<{ id: string }>`
      INSERT INTO ${sql.table(ident(object.table))} (${sql.join(cols)}) VALUES (${sql.join(vals)})
      RETURNING id`.execute(tx.kysely);
    id = String(rows.rows[0]?.id);
    version = 1;
  } else {
    const sets = [
      ...assignments.map(([c, v]) => sql`${sql.ref(c)} = ${v}`),
      sql`custom = ${JSON.stringify(custom)}::jsonb`,
      sql`version = version + 1`,
      sql`updated_by = ${ctx.userId}::uuid`,
      sql`updated_at = now()`,
    ];
    const rows = await sql<{ version: number }>`
      UPDATE ${sql.table(ident(object.table))} SET ${sql.join(sets)}
      WHERE tenant_id = ${tenantId}::uuid AND id = ${current.id}::uuid
      RETURNING version`.execute(tx.kysely);
    id = current.id;
    version = Number(rows.rows[0]?.version);
  }

  // History (§4.5, §7.17): opportunity stage history and tracked-field history.
  if (
    object.apiName === 'opportunity' &&
    (isNew || OPPORTUNITY_TRACKED.some((n) => changedSet.has(n)) || currencyChanged)
  )
    await tx.prisma.opportunityStageHistory.create({
      data: {
        tenantId,
        opportunityId: id,
        stage: String(values['stage']),
        amount: (values['amount'] as string | null) ?? null,
        currencyCode,
        closeDate: new Date(String(values['close_date'])),
        forecastCategory: String(values['forecast_category']),
        probability: (values['probability'] as string | null) ?? null,
        changedBy: ctx.userId,
      },
    });
  if (!isNew) {
    const tracked = object.fields.filter((f) => f.trackHistory && changedSet.has(f.apiName));
    if (tracked.length)
      await tx.prisma.fieldHistory.createMany({
        data: tracked.map((f) => ({
          tenantId,
          object: object.apiName,
          recordId: id,
          field: f.apiName,
          oldValue: (current.values[f.apiName] ?? null) as never,
          newValue: (values[f.apiName] ?? null) as never,
          changedBy: ctx.userId,
          requestId: ctx.requestId ?? null,
        })),
      });
  }

  const rules = await activeRules(tx, object.apiName);
  if (rules.length)
    await evaluateRulesForRecord(tx.kysely, {
      tenantId,
      recordTable: object.table,
      recordId: id,
      rules,
    });

  // Audit and events carry field names, never values: values of hidden fields must not leak (§6.5).
  await audit.record(tx, {
    action: isNew ? 'record.created' : 'record.updated',
    object: object.apiName,
    recordId: id,
    payload: { fields: changed },
    ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
  });
  const events = [
    {
      topic: isNew ? 'automation.record_created' : 'automation.record_updated',
      aggregateType: object.apiName,
      aggregateId: id,
      payload: { object: object.apiName, id, changedFields: changed },
    },
  ];
  if (!isNew && changedSet.has('owner_id'))
    events.push({
      topic: 'automation.owner_changed',
      aggregateType: object.apiName,
      aggregateId: id,
      payload: { object: object.apiName, id, changedFields: ['owner_id'] },
    });
  if (!isNew && object.apiName === 'opportunity' && changedSet.has('stage'))
    events.push({
      topic: 'automation.stage_changed',
      aggregateType: object.apiName,
      aggregateId: id,
      payload: { object: object.apiName, id, changedFields: ['stage'] },
    });
  await outbox.emit(tx, events);
  return { id, version, recordNumber, changed };
}

/** Drop platform-maintained fields from what is written (the pipeline writes those itself). */
function stripReadOnly(
  object: ObjectMeta,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const computed = new Set(['is_closed', 'is_won']);
  return Object.fromEntries(
    Object.entries(values).filter(([name]) => {
      const f: FieldMeta | undefined = object.fields.find((x) => x.apiName === name);
      if (!f || READ_ONLY_TYPES.has(f.type)) return false;
      return !f.system || computed.has(name);
    }),
  );
}

/** Create a record (§3.7). */
export async function createRecord(
  tx: TenantTransaction,
  ctx: RecordContext,
  objectName: string,
  input: WriteInput,
  options: WriteOptions = {},
): Promise<WriteResult> {
  const object = objectOf(ctx, objectName);
  if (!objectAccess(ctx.permissions, objectName).create) throw new RecordError('forbidden');
  return write(tx, ctx, object, null, input, options);
}

/**
 * Update a record (§3.7). `expectedVersion` is the version the caller read (optimistic
 * concurrency, `If-Match`); null skips the check (internal callers that hold the lock).
 */
export async function updateRecord(
  tx: TenantTransaction,
  ctx: RecordContext,
  objectName: string,
  id: string,
  input: WriteInput,
  expectedVersion: number | null,
  options: WriteOptions = {},
): Promise<WriteResult> {
  const object = objectOf(ctx, objectName);
  if (!(await hasAccess(tx, ctx, object, id, 'read'))) throw new RecordError('not_found');
  if (
    !objectAccess(ctx.permissions, objectName).edit ||
    !(await hasAccess(tx, ctx, object, id, 'edit'))
  )
    throw new RecordError('forbidden');
  const current = await readStored(tx, object, id, { lock: true });
  if (!current) throw new RecordError('not_found');
  if (expectedVersion !== null && current.version !== expectedVersion)
    throw new RecordError('conflict', [{ field: '_record', code: 'version_mismatch' }], {
      id,
      version: current.version,
    });
  if (object.apiName === 'lead' && current.values['converted_at'] && !options.conversion)
    throw new RecordError('conflict', [{ field: '_record', code: 'record_locked' }]);
  // Changing the owner transfers the record: that needs Full access (§6.3).
  const newOwner = input.fields['owner_id'];
  if (
    newOwner !== undefined &&
    newOwner !== current.values['owner_id'] &&
    !(await hasAccess(tx, ctx, object, id, 'full'))
  )
    throw new RecordError('forbidden', [{ field: 'owner_id', code: 'transfer_not_allowed' }]);
  return write(tx, ctx, object, current, input, options);
}
