import { audit, outbox, type TenantTransaction } from '@sm/db';
import type { FieldMeta, MetadataIndex } from '@sm/metadata';
import { fieldAccess } from '@sm/permissions';

import type { RecordContext } from './context.js';
import { hardDelete } from './delete.js';
import { RecordError, type FieldError } from './errors.js';
import { createRecord, hasAccess, updateRecord } from './service.js';
import { readStored } from './storage.js';

/** Objects a lead converts into (§7.3). */
export type ConversionTarget = 'account' | 'contact' | 'opportunity';
const TARGETS: readonly ConversionTarget[] = ['account', 'contact', 'opportunity'];
/** Undo is possible this long after converting, if nothing was touched since (§7.3). */
export const UNDO_WINDOW_MS = 24 * 3_600_000;

export interface FieldMapping {
  leadField: string;
  targetObject: ConversionTarget;
  targetField: string;
}

const address = (prefix: string) =>
  ['street', 'city', 'state', 'postal_code', 'country'].map((p) => [p, `${prefix}${p}`] as const);

/** The standard mapping every organisation starts with; admin mappings override per target field. */
export const DEFAULT_MAPPINGS: readonly FieldMapping[] = [
  ...(
    [
      ['company', 'name'],
      ['website', 'website'],
      ['phone', 'phone'],
      ['industry', 'industry'],
      ['annual_revenue', 'annual_revenue'],
      ['number_of_employees', 'number_of_employees'],
      ...address('billing_'),
    ] as const
  ).map(([leadField, targetField]) => ({
    leadField,
    targetObject: 'account' as const,
    targetField,
  })),
  ...(
    [
      ['first_name', 'first_name'],
      ['last_name', 'last_name'],
      ['title', 'title'],
      ['email', 'email'],
      ['phone', 'phone'],
      ['mobile_phone', 'mobile_phone'],
      ['lead_source', 'lead_source'],
      ['description', 'description'],
      ['do_not_call', 'do_not_call'],
      ['email_opt_out', 'email_opt_out'],
      ...address('mailing_'),
    ] as const
  ).map(([leadField, targetField]) => ({
    leadField,
    targetObject: 'contact' as const,
    targetField,
  })),
  ...(
    [
      ['lead_source', 'lead_source'],
      ['campaign_id', 'campaign_id'],
    ] as const
  ).map(([leadField, targetField]) => ({
    leadField,
    targetObject: 'opportunity' as const,
    targetField,
  })),
];

const TEXTUAL = new Set(['text', 'textarea', 'long_text', 'email', 'phone', 'url']);
const WIDE_TEXT = new Set(['text', 'textarea', 'long_text']);
const LOOKUPS = new Set(['lookup', 'master_detail', 'user']);

/**
 * Whether a lead field's values fit a target field (§7.3 type-compatibility check): the same
 * type, or text-like into a text field long enough, or a lookup to the same object.
 */
export function compatible(from: FieldMeta, to: FieldMeta): boolean {
  if (LOOKUPS.has(from.type) || LOOKUPS.has(to.type))
    return (
      LOOKUPS.has(from.type) &&
      LOOKUPS.has(to.type) &&
      from.referenceTo.length > 0 &&
      from.referenceTo.every((r) => to.referenceTo.includes(r))
    );
  const fits = to.length === null || (from.length !== null && from.length <= to.length);
  if (from.type === to.type) return TEXTUAL.has(from.type) ? fits : true;
  return TEXTUAL.has(from.type) && WIDE_TEXT.has(to.type) && fits;
}

/** Check mappings against metadata; field errors keyed by `mappings.<i>`. */
export function checkMappings(
  metadata: MetadataIndex,
  mappings: readonly FieldMapping[],
): FieldError[] {
  const errors: FieldError[] = [];
  const seen = new Set<string>();
  for (const [i, m] of mappings.entries()) {
    const at = `mappings.${String(i)}`;
    const from = metadata.field('lead', m.leadField);
    const to = TARGETS.includes(m.targetObject)
      ? metadata.field(m.targetObject, m.targetField)
      : undefined;
    if (!from || from.system) errors.push({ field: at, code: 'unknown_lead_field' });
    else if (!to || to.system || to.apiName === 'owner_id')
      errors.push({ field: at, code: 'unknown_target_field' });
    else if (!compatible(from, to)) errors.push({ field: at, code: 'incompatible_types' });
    const key = `${m.targetObject}.${m.targetField}`;
    if (seen.has(key)) errors.push({ field: at, code: 'duplicate_target' });
    seen.add(key);
  }
  return errors;
}

/** The admin's mappings over the defaults (one source per target field). */
export async function effectiveMappings(tx: TenantTransaction): Promise<FieldMapping[]> {
  const custom = await tx.prisma.leadFieldMapping.findMany({ orderBy: { createdAt: 'asc' } });
  const byTarget = new Map<string, FieldMapping>();
  for (const m of DEFAULT_MAPPINGS) byTarget.set(`${m.targetObject}.${m.targetField}`, m);
  for (const m of custom)
    byTarget.set(`${m.targetObject}.${m.targetField}`, {
      leadField: m.leadField,
      targetObject: m.targetObject as ConversionTarget,
      targetField: m.targetField,
    });
  return [...byTarget.values()];
}

/** Replace the admin's mappings (Setup; the caller checks customize_application). */
export async function saveMappings(
  tx: TenantTransaction,
  metadata: MetadataIndex,
  mappings: readonly FieldMapping[],
): Promise<void> {
  const errors = checkMappings(metadata, mappings);
  if (errors.length) throw new RecordError('invalid', errors);
  const before = await tx.prisma.leadFieldMapping.findMany();
  await tx.prisma.leadFieldMapping.deleteMany({});
  if (mappings.length)
    await tx.prisma.leadFieldMapping.createMany({
      data: mappings.map((m) => ({
        tenantId: tx.context.tenantId,
        leadField: m.leadField,
        targetObject: m.targetObject,
        targetField: m.targetField,
        createdBy: tx.context.userId ?? null,
      })),
    });
  await audit.setup(tx, {
    action: 'lead_field_mapping.replaced',
    entityType: 'lead_field_mapping',
    before: { mappings: before.map((m) => `${m.leadField}→${m.targetObject}.${m.targetField}`) },
    after: { mappings: mappings.map((m) => `${m.leadField}→${m.targetObject}.${m.targetField}`) },
  });
}

export interface ConvertInput {
  /** An existing account the caller can see, or fields for a new one (over the mapped values). */
  account: { id: string } | { fields?: Record<string, unknown> };
  /** An existing contact (of that account, or of none), or fields for a new one. */
  contact: { id: string } | { fields?: Record<string, unknown> };
  /** Fields for a new opportunity; omitted or null converts without one. */
  opportunity?: { fields?: Record<string, unknown> } | null;
  /** Owner of the new records (default: the caller). */
  ownerId?: string;
  /** A lead status of category CONVERTED (default: the first one). */
  convertedStatus?: string;
}

export interface ConvertResult {
  conversionId: string;
  accountId: string;
  contactId: string;
  opportunityId: string | null;
}

/** Mapped values from the lead for one target: readable on the lead, editable on the target. */
function mapped(
  ctx: RecordContext,
  mappings: readonly FieldMapping[],
  lead: Record<string, unknown>,
  target: ConversionTarget,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of mappings) {
    if (m.targetObject !== target) continue;
    const value = lead[m.leadField];
    if (value === null || value === undefined || value === '') continue;
    const from = ctx.metadata.field('lead', m.leadField);
    const to = ctx.metadata.field(target, m.targetField);
    if (!from || !to) continue;
    if (!fieldAccess(ctx.permissions, 'lead', m.leadField, from).read) continue;
    if (!fieldAccess(ctx.permissions, target, m.targetField, to).edit) continue;
    // A picklist value the target does not offer is left out rather than failing the convert.
    if (
      (to.type === 'picklist' || to.type === 'multi_picklist') &&
      !(Array.isArray(value) ? value : [value]).every((v) =>
        ctx.metadata.picklistValues(target, m.targetField, null).some((p) => p.apiValue === v),
      )
    )
      continue;
    out[m.targetField] = value;
  }
  return out;
}

const existingId = (x: ConvertInput['account']): string | null =>
  'id' in x && typeof x.id === 'string' ? x.id : null;

/**
 * Convert a lead (§7.3), in the caller's transaction and as the caller: every record goes
 * through RecordService, so permissions, FLS, validation rules and history apply as for any
 * write. The lead becomes CONVERTED and read-only, linked to what it became.
 */
export async function convertLead(
  tx: TenantTransaction,
  ctx: RecordContext,
  leadId: string,
  input: ConvertInput,
): Promise<ConvertResult> {
  const leadMeta = ctx.metadata.object('lead');
  if (!leadMeta || !(await hasAccess(tx, ctx, leadMeta, leadId, 'read')))
    throw new RecordError('not_found');
  if (!(await hasAccess(tx, ctx, leadMeta, leadId, 'edit'))) throw new RecordError('forbidden');
  const lead = await readStored(tx, leadMeta, leadId, { lock: true });
  if (!lead) throw new RecordError('not_found');
  if (lead.values['converted_at'])
    throw new RecordError('conflict', [{ field: '_record', code: 'already_converted' }]);

  const converted = (ctx.metadata.field('lead', 'status')?.picklistValues ?? []).filter(
    (v) => v.category === 'CONVERTED' && v.active,
  );
  const status = input.convertedStatus ?? converted[0]?.apiValue;
  if (!status || !converted.some((v) => v.apiValue === status))
    throw new RecordError('invalid', [
      { field: 'convertedStatus', code: 'not_a_converted_status' },
    ]);

  const mappings = await effectiveMappings(tx);
  const owner = input.ownerId ?? ctx.userId;
  const currency = lead.currencyCode ? { currencyCode: lead.currencyCode } : {};
  const versions: Record<string, number> = {};
  const requireVisible = async (object: ConversionTarget, id: string, field: string) => {
    const meta = ctx.metadata.object(object);
    if (!meta || !(await hasAccess(tx, ctx, meta, id, 'read')))
      throw new RecordError('invalid', [{ field, code: 'invalid_reference' }]);
    return meta;
  };

  // Account: existing (visible to the caller) or new from the mapping.
  let accountId = existingId(input.account);
  const createdAccount = accountId === null;
  if (accountId) await requireVisible('account', accountId, 'account.id');
  else {
    const extra = 'fields' in input.account ? (input.account.fields ?? {}) : {};
    const done = await createRecord(tx, ctx, 'account', {
      fields: { ...mapped(ctx, mappings, lead.values, 'account'), owner_id: owner, ...extra },
      ...currency,
    });
    accountId = done.id;
    versions['account'] = done.version;
  }

  // Contact: existing (of this account or of none, which then joins it) or new.
  let contactId = existingId(input.contact);
  const createdContact = contactId === null;
  let joinedAccount = false;
  if (contactId) {
    const meta = await requireVisible('contact', contactId, 'contact.id');
    const stored = await readStored(tx, meta, contactId);
    const current = stored?.values['account_id'] ?? null;
    if (current !== null && current !== accountId)
      throw new RecordError('invalid', [{ field: 'contact.id', code: 'contact_of_other_account' }]);
    if (current === null) {
      const done = await updateRecord(
        tx,
        ctx,
        'contact',
        contactId,
        {
          fields: { account_id: accountId },
        },
        null,
      );
      versions['contact'] = done.version;
      joinedAccount = true;
    }
  } else {
    const extra = 'fields' in input.contact ? (input.contact.fields ?? {}) : {};
    const done = await createRecord(tx, ctx, 'contact', {
      fields: {
        ...mapped(ctx, mappings, lead.values, 'contact'),
        owner_id: owner,
        account_id: accountId,
        ...extra,
      },
    });
    contactId = done.id;
    versions['contact'] = done.version;
  }

  // Opportunity: optional; pipeline and stage come from its record type in RecordService.
  let opportunityId: string | null = null;
  if (input.opportunity) {
    const company = typeof lead.values['company'] === 'string' ? lead.values['company'] : '';
    const done = await createRecord(tx, ctx, 'opportunity', {
      fields: {
        name: company,
        ...mapped(ctx, mappings, lead.values, 'opportunity'),
        owner_id: owner,
        account_id: accountId,
        primary_contact_id: contactId,
        ...(input.opportunity.fields ?? {}),
      },
      ...currency,
    });
    opportunityId = done.id;
    versions['opportunity'] = done.version;
    await tx.prisma.opportunityContactRole.create({
      data: {
        tenantId: tx.context.tenantId,
        opportunityId,
        contactId,
        isPrimary: true,
        createdBy: ctx.userId,
      },
    });
  }

  // Campaign memberships carry over to the contact, unless it is already a member; the lead's
  // stay as history (activities join in P03).
  const memberships = await tx.prisma.campaignMember.findMany({ where: { leadId } });
  const already = new Set(
    (
      await tx.prisma.campaignMember.findMany({
        where: { contactId, campaignId: { in: memberships.map((m) => m.campaignId) } },
        select: { campaignId: true },
      })
    ).map((m) => m.campaignId),
  );
  const addedMemberships: string[] = [];
  for (const m of memberships.filter((x) => !already.has(x.campaignId))) {
    const added = await tx.prisma.campaignMember.create({
      data: {
        tenantId: tx.context.tenantId,
        campaignId: m.campaignId,
        contactId,
        status: m.status,
        responded: m.responded,
        firstRespondedAt: m.firstRespondedAt,
        createdBy: ctx.userId,
      },
    });
    addedMemberships.push(added.id);
  }

  const now = ctx.now?.() ?? new Date();
  const leadDone = await updateRecord(tx, ctx, 'lead', leadId, { fields: { status } }, null, {
    conversion: true,
    system: {
      converted_at: now.toISOString(),
      converted_account_id: accountId,
      converted_contact_id: contactId,
      converted_opportunity_id: opportunityId,
    },
  });
  versions['lead'] = leadDone.version;

  const conversion = await tx.prisma.leadConversion.create({
    data: {
      tenantId: tx.context.tenantId,
      leadId,
      accountId,
      contactId,
      opportunityId,
      createdAccount,
      createdContact,
      leadBefore: {
        status: lead.values['status'] ?? null,
        joinedAccount,
        addedMemberships,
      } as never,
      recordVersions: versions,
      convertedAt: now,
      convertedBy: ctx.userId,
    },
  });
  await audit.record(tx, {
    action: 'lead.converted',
    object: 'lead',
    recordId: leadId,
    payload: { accountId, contactId, opportunityId, createdAccount, createdContact },
    ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
  });
  await outbox.emit(tx, {
    topic: 'automation.lead_converted',
    aggregateType: 'lead',
    aggregateId: leadId,
    payload: { object: 'lead', id: leadId, changedFields: ['status'] },
  });
  return { conversionId: conversion.id, accountId, contactId, opportunityId };
}

/**
 * Undo a conversion within 24 h (§7.3), by whoever converted or a user who may modify all data,
 * if the lead and every record conversion wrote are untouched since. The created records go for
 * good (they never existed for anyone else), a contact that joined the account leaves it again,
 * and the lead returns to its earlier status.
 */
export async function undoConversion(
  tx: TenantTransaction,
  ctx: RecordContext,
  leadId: string,
): Promise<void> {
  const leadMeta = ctx.metadata.object('lead');
  if (!leadMeta || !(await hasAccess(tx, ctx, leadMeta, leadId, 'read')))
    throw new RecordError('not_found');
  const conversion = await tx.prisma.leadConversion.findFirst({
    where: { leadId, undoneAt: null },
    orderBy: { convertedAt: 'desc' },
  });
  if (!conversion) throw new RecordError('not_found');
  if (conversion.convertedBy !== ctx.userId && !ctx.permissions.system.has('modify_all_data'))
    throw new RecordError('forbidden', [{ field: '_record', code: 'not_your_conversion' }]);
  const now = ctx.now?.() ?? new Date();
  if (now.getTime() - conversion.convertedAt.getTime() > UNDO_WINDOW_MS)
    throw new RecordError('conflict', [{ field: '_record', code: 'undo_window_passed' }]);

  const versions = conversion.recordVersions as Record<string, number>;
  const ids: Record<string, string | null> = {
    lead: leadId,
    account: conversion.accountId,
    contact: conversion.contactId,
    opportunity: conversion.opportunityId,
  };
  for (const [object, version] of Object.entries(versions)) {
    const meta = ctx.metadata.object(object);
    const id = ids[object];
    const stored = meta && id ? await readStored(tx, meta, id, { lock: true }) : null;
    if (stored?.version !== version)
      throw new RecordError('conflict', [{ field: object, code: 'changed_since_conversion' }]);
  }

  const before = conversion.leadBefore as {
    status?: string | null;
    joinedAccount?: boolean;
    addedMemberships?: string[];
  };
  // The lead first: its links to the records go before they do.
  await updateRecord(tx, ctx, 'lead', leadId, { fields: { status: before.status ?? null } }, null, {
    conversion: true,
    system: {
      converted_at: null,
      converted_account_id: null,
      converted_contact_id: null,
      converted_opportunity_id: null,
    },
  });
  if (before.addedMemberships?.length)
    await tx.prisma.campaignMember.deleteMany({ where: { id: { in: before.addedMemberships } } });
  const created = new Map<string, string[]>();
  if (conversion.opportunityId) created.set('opportunity', [conversion.opportunityId]);
  if (conversion.createdContact) created.set('contact', [conversion.contactId]);
  if (conversion.createdAccount) created.set('account', [conversion.accountId]);
  await hardDelete(tx, ctx.metadata, created);
  if (!conversion.createdContact && before.joinedAccount)
    await updateRecord(
      tx,
      ctx,
      'contact',
      conversion.contactId,
      {
        fields: { account_id: null },
      },
      null,
    );

  await tx.prisma.leadConversion.update({
    where: { tenantId_id: { tenantId: tx.context.tenantId, id: conversion.id } },
    data: { undoneAt: now, undoneBy: ctx.userId },
  });
  await audit.record(tx, {
    action: 'lead.conversion_undone',
    object: 'lead',
    recordId: leadId,
    payload: { conversionId: conversion.id },
    ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
  });
}
