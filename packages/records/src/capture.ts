import type { TenantTransaction } from '@sm/db';
import { sql } from 'kysely';

import { loadRecordContext } from './load-context.js';
import { findMatches, type MatchCondition } from './duplicates.js';
import { RecordError, type FieldError } from './errors.js';
import { scoreRecords } from './scoring.js';
import { createRecord } from './service.js';

/*
 * The capture pipeline (§7.1, P03 T19/T21): what web forms and email-to-lead share. A lead is
 * created through RecordService as the capture point's run-as user, with the source fields every
 * capture path sets (`lead_source`, `lead_source_detail`, `campaign_id`, `captured_via`, UTM and
 * click ids), duplicate rules and the capture point's assignment rule. A Block duplicate rule does
 * not lose the submission: it is linked to the existing lead instead.
 */

export type CapturedVia = 'web_form' | 'email';

export interface CaptureSource {
  capturedVia: CapturedVia;
  /** `lead_source_detail`: the form's or the address's name. */
  detail: string;
  utm?: Partial<Record<'source' | 'medium' | 'campaign' | 'term' | 'content', string>>;
  referrer?: string;
  landingPage?: string;
  gclid?: string;
  fbclid?: string;
}

export interface CaptureInput {
  runAsUserId: string;
  /** What the visitor or the email provided. */
  fields: Record<string, unknown>;
  /** The capture point's values for fields left empty (lead source, campaign, owner). */
  defaults: Record<string, unknown>;
  source: CaptureSource;
  assignmentRuleId: string | null;
}

export interface CaptureResult {
  /** CREATED: a new lead. DUPLICATE: a Block rule matched an existing lead. FAILED: refused. */
  status: 'CREATED' | 'DUPLICATE' | 'FAILED';
  recordId: string | null;
  errors: FieldError[];
}

const DEFAULT_LEAD_SOURCE: Record<CapturedVia, string> = { web_form: 'web', email: 'email' };
const empty = (v: unknown) => v === undefined || v === null || v === '';
/** Text fields are 255 long; URLs and click ids from the wild are cut, never refused. */
const clip = (v: string | undefined, max = 255) => (v ? v.slice(0, max) : undefined);

/** The lead's values: the input, then defaults for what it left empty, then the source fields. */
export function captureValues(input: CaptureInput): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.fields)) if (!empty(v)) values[k] = v;
  for (const [k, v] of Object.entries(input.defaults))
    if (empty(values[k]) && !empty(v)) values[k] = v;
  const s = input.source;
  values['lead_source'] ??= DEFAULT_LEAD_SOURCE[s.capturedVia];
  values['lead_source_detail'] ??= clip(s.detail);
  values['captured_via'] = s.capturedVia;
  const extra: Record<string, string | undefined> = {
    utm_source: clip(s.utm?.source),
    utm_medium: clip(s.utm?.medium),
    utm_campaign: clip(s.utm?.campaign),
    utm_term: clip(s.utm?.term),
    utm_content: clip(s.utm?.content),
    referrer: clip(s.referrer, 2000),
    landing_page: clip(s.landingPage, 2000),
    gclid: clip(s.gclid),
    fbclid: clip(s.fbclid),
  };
  for (const [k, v] of Object.entries(extra)) if (v) values[k] ??= v;
  return values;
}

/** Campaign attribution: an active campaign named like `utm_campaign` (any case), if exactly one. */
async function campaignNamed(tx: TenantTransaction, name: string): Promise<string | null> {
  const rows = await sql<{ id: string }>`
    SELECT id FROM campaign
    WHERE tenant_id = ${tx.context.tenantId}::uuid AND deleted_at IS NULL
      AND lower(name) = lower(${name})
    LIMIT 2`.execute(tx.kysely);
  return rows.rows.length === 1 ? (rows.rows[0]?.id ?? null) : null;
}

/** The existing lead a blocked capture matched: best score under any active matching rule. */
async function existingMatch(
  tx: TenantTransaction,
  ctx: Awaited<ReturnType<typeof loadRecordContext>>,
  values: Record<string, unknown>,
): Promise<string | null> {
  const object = ctx.metadata.object('lead');
  if (!object) return null;
  const rules = await tx.prisma.matchingRule.findMany({ where: { object: 'lead', active: true } });
  let best: { id: string; score: number } | null = null;
  for (const rule of rules) {
    const matches = await findMatches(
      tx,
      ctx,
      object,
      {
        id: rule.id,
        name: rule.name,
        object: rule.object,
        conditions: rule.conditions as unknown as MatchCondition[],
        matchBlank: rule.matchBlank,
      },
      [{ index: 0, id: null, values }],
    );
    for (const m of matches.get(0) ?? [])
      if (m.id && (!best || m.score > best.score)) best = { id: m.id, score: m.score };
  }
  return best?.id ?? null;
}

/**
 * Create the captured lead inside a savepoint, so a refusal leaves the caller's transaction (and
 * its stored submission) intact, then record the event and rescore the lead. Errors other than
 * RecordService refusals propagate.
 */
export async function captureLead(
  tx: TenantTransaction,
  input: CaptureInput,
  /** Store the capture event (submission, inbound email) with its outcome, before rescoring. */
  recordEvent: (result: CaptureResult) => Promise<void> = () => Promise.resolve(),
): Promise<CaptureResult> {
  const ctx = await loadRecordContext(tx, input.runAsUserId);
  const result = await create(tx, ctx, input);
  await recordEvent(result);
  // The event counts towards engagement (§7.4), on a new lead or the existing one.
  if (result.recordId)
    await scoreRecords(tx, { metadata: ctx.metadata, timezone: ctx.timezone }, 'lead', [
      result.recordId,
    ]);
  return result;
}

async function create(
  tx: TenantTransaction,
  ctx: Awaited<ReturnType<typeof loadRecordContext>>,
  input: CaptureInput,
): Promise<CaptureResult> {
  const values = captureValues(input);
  const utmCampaign = input.source.utm?.campaign;
  if (empty(values['campaign_id']) && utmCampaign) {
    const campaignId = await campaignNamed(tx, utmCampaign);
    if (campaignId) values['campaign_id'] = campaignId;
  }
  await sql`SAVEPOINT sm_capture`.execute(tx.kysely);
  try {
    const result = await createRecord(
      tx,
      ctx,
      'lead',
      { fields: values },
      { assign: { source: input.source.capturedVia, ruleId: input.assignmentRuleId } },
    );
    await sql`RELEASE SAVEPOINT sm_capture`.execute(tx.kysely);
    return { status: 'CREATED', recordId: result.id, errors: [] };
  } catch (err) {
    await sql`ROLLBACK TO SAVEPOINT sm_capture`.execute(tx.kysely);
    await sql`RELEASE SAVEPOINT sm_capture`.execute(tx.kysely);
    if (!(err instanceof RecordError)) throw err;
    if (err.errors.some((e) => e.code === 'duplicate_blocked'))
      return {
        status: 'DUPLICATE',
        recordId: await existingMatch(tx, ctx, values),
        errors: err.errors,
      };
    return {
      status: 'FAILED',
      recordId: null,
      errors: err.errors.length ? err.errors : [{ field: '_record', code: err.code }],
    };
  }
}
