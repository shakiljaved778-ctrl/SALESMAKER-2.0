import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateWebFormRequest,
  UpdateWebFormRequest,
  WebFormDto,
  WebFormSubmissionDto,
} from '@sm/contracts';
import { audit, type TenantTransaction } from '@sm/db';
import type { CaptchaVerifier } from '@sm/integrations';
import type { FieldMeta } from '@sm/metadata';
import { fieldAccess, objectAccess } from '@sm/permissions';
import { errors } from '@sm/server-kit';
import type { z } from 'zod';

import { isWritable, MetadataService } from '../metadata/metadata.service.js';
import { PermissionService } from '../permissions/permission.service.js';
import { assertVersion } from '../setup/common.js';
import { CAPTCHA } from '../tokens.js';

type Form = z.infer<typeof WebFormDto>;
type Input = z.output<typeof CreateWebFormRequest>;
type Problem = { field: string; code: string; message: string };

const INCLUDE = {
  fields: { orderBy: { sortOrder: 'asc' as const } },
  runAs: { select: { id: true, name: true } },
};

interface Row {
  id: string;
  name: string;
  status: Form['status'];
  settings: unknown;
  defaults: unknown;
  assignmentRuleId: string | null;
  autoResponder: unknown;
  version: number;
  runAs: { id: string; name: string };
  fields: {
    field: string;
    label: string | null;
    required: boolean;
    hidden: boolean;
    defaultValue: unknown;
    values: string[];
  }[];
}

const dto = (r: Row): Form => ({
  id: r.id,
  name: r.name,
  object: 'lead',
  status: r.status,
  runAsUser: r.runAs,
  fields: r.fields.map((f) => ({
    field: f.field,
    label: f.label,
    required: f.required,
    hidden: f.hidden,
    defaultValue: (f.defaultValue ?? null) as Form['fields'][number]['defaultValue'],
    values: f.values,
  })),
  settings: r.settings as Form['settings'],
  defaults: r.defaults as Form['defaults'],
  assignmentRuleId: r.assignmentRuleId,
  autoResponder: r.autoResponder as Form['autoResponder'],
  version: r.version,
});

const auditView = (f: Form) =>
  JSON.parse(JSON.stringify({ ...f, version: undefined })) as Record<string, never>;
/** Field types a visitor can fill in on a form. */
export const VISITOR_TYPES: ReadonlySet<string> = new Set([
  'text',
  'textarea',
  'long_text',
  'email',
  'phone',
  'url',
  'number',
  'currency',
  'percent',
  'date',
  'checkbox',
  'picklist',
  'multi_picklist',
]);
const empty = (v: unknown) =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/** Setup → Web forms (§7.1). Reading needs view_setup, changes customize_application. */
@Injectable()
export class WebFormsSetupService {
  constructor(
    private readonly metadata: MetadataService,
    private readonly permissions: PermissionService,
    @Inject(CAPTCHA) private readonly captcha: CaptchaVerifier | null,
  ) {}

  /**
   * Everything that would make submissions fail, checked up front: a run-as user who can create
   * leads and edit every field the form sets, picklist subsets of active values, hidden fields
   * with values, required lead fields covered, Turnstile only with keys, an auto-responder only
   * with an email field, and a lead assignment rule.
   */
  private async check(tx: TenantTransaction, form: Input): Promise<void> {
    const problems: Problem[] = [];
    const add = (field: string, code: string, message: string) =>
      problems.push({ field, code, message });
    const runAs = await tx.prisma.user.findFirst({
      where: { id: form.runAsUserId, status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });
    if (!runAs)
      throw errors.validation([
        { field: 'runAsUserId', code: 'invalid_reference', message: 'No such active user' },
      ]);
    const perms = await this.permissions.forUser(tx, runAs.id);
    if (!objectAccess(perms, 'lead').create)
      add('runAsUserId', 'cannot_create', 'This user cannot create leads');
    const lead = (await this.metadata.forTenant(tx)).object('lead');
    if (!lead) throw errors.notFound('Object');
    const settable = (name: string): FieldMeta | null => {
      const f = lead.fields.find((x) => x.apiName === name);
      return f && isWritable(f) && fieldAccess(perms, 'lead', f.apiName, f).edit ? f : null;
    };
    for (const [i, ff] of form.fields.entries()) {
      const at = `fields.${String(i)}`;
      const f = settable(ff.field);
      if (!f) {
        add(`${at}.field`, 'not_editable', 'The run-as user cannot set this field');
        continue;
      }
      // Visitors type values; references (campaign, owner) come from hidden fields or defaults.
      if (!ff.hidden && !VISITOR_TYPES.has(f.type))
        add(`${at}.hidden`, 'not_supported', 'Visitors cannot fill this type of field');
      if (ff.hidden && empty(ff.defaultValue))
        add(`${at}.defaultValue`, 'required', 'A hidden field needs a value');
      const picklist = f.type === 'picklist' || f.type === 'multi_picklist';
      if (ff.values.length && !picklist)
        add(`${at}.values`, 'not_applicable', 'Only picklists offer values');
      const active = new Set(f.picklistValues.filter((v) => v.active).map((v) => v.apiValue));
      if (picklist && ff.values.some((v) => !active.has(v)))
        add(`${at}.values`, 'invalid_value', 'Not an active value of this picklist');
    }
    for (const key of Object.keys(form.defaults))
      if (!settable(key))
        add(`defaults.${key}`, 'not_editable', 'The run-as user cannot set this field');
    // Every required lead field must get a value: from the visitor, a hidden field or a default.
    const given = new Set([
      ...form.fields.filter((f) => !f.hidden && f.required).map((f) => f.field),
      ...form.fields.filter((f) => f.hidden && !empty(f.defaultValue)).map((f) => f.field),
      ...Object.entries(form.defaults)
        .filter(([, v]) => !empty(v))
        .map(([k]) => k),
    ]);
    // RecordService fills the owner (the writer) and defaults (a field's, a picklist's default).
    const defaulted = (f: FieldMeta) =>
      f.apiName === 'owner_id' ||
      !empty(f.defaultValue) ||
      (f.type === 'picklist' && f.picklistValues.some((v) => v.active && v.isDefault));
    for (const f of lead.fields)
      if (f.required && isWritable(f) && !defaulted(f) && !given.has(f.apiName))
        add('fields', 'missing_required', `Required on leads: ${f.apiName}`);
    if (form.status === 'ACTIVE' && !form.fields.some((f) => !f.hidden))
      add('fields', 'required', 'An active form shows at least one field');
    if (form.settings.turnstile && !this.captcha)
      add('settings.turnstile', 'unavailable', 'Turnstile keys are not configured for this region');
    const keys = form.settings.consents.map((c) => c.key);
    if (new Set(keys).size !== keys.length)
      add('settings.consents', 'duplicate', 'Each consent needs its own key');
    const emailShown = form.fields.some(
      (ff) => !ff.hidden && lead.fields.find((f) => f.apiName === ff.field)?.type === 'email',
    );
    if (form.autoResponder && !emailShown)
      add('autoResponder', 'needs_email', 'An auto-responder needs an email field on the form');
    if (form.assignmentRuleId) {
      const rule = await tx.prisma.assignmentRule.findFirst({
        where: { id: form.assignmentRuleId, object: 'lead' },
      });
      if (!rule) add('assignmentRuleId', 'invalid_reference', 'No such lead assignment rule');
    }
    if (problems.length) throw errors.validation(problems);
  }

  private async writeFields(tx: TenantTransaction, formId: string, fields: Input['fields']) {
    await tx.prisma.webFormField.deleteMany({ where: { formId } });
    if (fields.length)
      await tx.prisma.webFormField.createMany({
        data: fields.map((f, i) => ({
          tenantId: tx.context.tenantId,
          formId,
          field: f.field,
          label: f.label,
          required: f.required,
          hidden: f.hidden,
          defaultValue: f.defaultValue === null ? undefined : f.defaultValue,
          values: f.values,
          sortOrder: i,
        })),
      });
  }

  async list(tx: TenantTransaction): Promise<Form[]> {
    return (await tx.prisma.webForm.findMany({ include: INCLUDE, orderBy: { name: 'asc' } })).map(
      dto,
    );
  }

  async get(tx: TenantTransaction, id: string): Promise<Form> {
    const row = await tx.prisma.webForm.findFirst({ where: { id }, include: INCLUDE });
    if (!row) throw errors.notFound('Web form');
    return dto(row);
  }

  async create(tx: TenantTransaction, input: Input): Promise<Form> {
    await this.check(tx, input);
    const row = await tx.prisma.webForm.create({
      data: {
        tenantId: tx.context.tenantId,
        name: input.name,
        object: input.object,
        status: input.status,
        runAsUserId: input.runAsUserId,
        settings: input.settings,
        defaults: input.defaults,
        assignmentRuleId: input.assignmentRuleId,
        autoResponder: input.autoResponder ?? undefined,
        createdBy: tx.context.userId ?? null,
        updatedBy: tx.context.userId ?? null,
      },
    });
    await this.writeFields(tx, row.id, input.fields);
    const out = await this.get(tx, row.id);
    await audit.setup(tx, {
      action: 'web_form.created',
      entityType: 'web_form',
      entityId: out.id,
      entityName: out.name,
      after: auditView(out),
    });
    return out;
  }

  async update(
    tx: TenantTransaction,
    id: string,
    input: z.output<typeof UpdateWebFormRequest>,
  ): Promise<Form> {
    const current = await tx.prisma.webForm.findFirst({ where: { id }, include: INCLUDE });
    assertVersion(current, input.version, 'Web form');
    const before = dto(current);
    const next: Input = {
      name: input.name ?? before.name,
      object: 'lead',
      status: input.status ?? before.status,
      runAsUserId: input.runAsUserId ?? before.runAsUser.id,
      fields: input.fields ?? before.fields,
      settings: input.settings ?? before.settings,
      defaults: input.defaults ?? before.defaults,
      assignmentRuleId:
        input.assignmentRuleId === undefined ? before.assignmentRuleId : input.assignmentRuleId,
      autoResponder: input.autoResponder === undefined ? before.autoResponder : input.autoResponder,
    };
    await this.check(tx, next);
    await tx.prisma.webForm.update({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
      data: {
        name: next.name,
        status: next.status,
        runAsUserId: next.runAsUserId,
        settings: next.settings,
        defaults: next.defaults,
        assignmentRuleId: next.assignmentRuleId,
        updatedBy: tx.context.userId ?? null,
        version: { increment: 1 },
      },
    });
    if (input.autoResponder !== undefined)
      await tx.prisma.$executeRaw`UPDATE web_form SET auto_responder = ${
        next.autoResponder ? JSON.stringify(next.autoResponder) : null
      }::jsonb WHERE tenant_id = ${tx.context.tenantId}::uuid AND id = ${id}::uuid`;
    if (input.fields) await this.writeFields(tx, id, next.fields);
    const out = await this.get(tx, id);
    await audit.setup(tx, {
      action: 'web_form.updated',
      entityType: 'web_form',
      entityId: id,
      entityName: out.name,
      before: auditView(before),
      after: auditView(out),
    });
    return out;
  }

  /** Deleting a form deletes its submissions; the leads they created stay. */
  async remove(tx: TenantTransaction, id: string): Promise<void> {
    const current = await tx.prisma.webForm.findFirst({ where: { id }, include: INCLUDE });
    if (!current) throw errors.notFound('Web form');
    await tx.prisma.webForm.delete({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
    });
    await audit.setup(tx, {
      action: 'web_form.deleted',
      entityType: 'web_form',
      entityId: id,
      entityName: current.name,
      before: auditView(dto(current)),
    });
  }

  async submissions(
    tx: TenantTransaction,
    id: string,
    q: {
      status?: z.infer<typeof WebFormSubmissionDto>['status'] | undefined;
      before?: string | undefined;
      limit: number;
    },
  ): Promise<{ items: z.infer<typeof WebFormSubmissionDto>[]; next: string | null }> {
    if (!(await tx.prisma.webForm.findFirst({ where: { id }, select: { id: true } })))
      throw errors.notFound('Web form');
    const rows = await tx.prisma.webFormSubmission.findMany({
      where: {
        formId: id,
        ...(q.status ? { status: q.status } : {}),
        ...(q.before ? { id: { lt: q.before } } : {}),
      },
      orderBy: { id: 'desc' },
      take: q.limit + 1,
      select: {
        id: true,
        receivedAt: true,
        status: true,
        recordId: true,
        reason: true,
        meta: true,
      },
    });
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((r) => {
        const meta = (r.meta ?? {}) as Record<string, unknown>;
        return {
          id: r.id,
          receivedAt: r.receivedAt.toISOString(),
          status: r.status,
          recordId: r.recordId,
          reason: r.reason,
          // Attribution only; the IP hash and user agent stay in the database.
          meta: Object.fromEntries(
            Object.entries(meta).filter(
              (e): e is [string, string] =>
                typeof e[1] === 'string' && e[0] !== 'ipHash' && e[0] !== 'userAgent',
            ),
          ),
        };
      }),
      next: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }
}
