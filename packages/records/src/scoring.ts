import type { TenantTransaction } from '@sm/db';
import { checkFormula, compileToSql, metadataEnvironment } from '@sm/formula';
import type { MetadataIndex, ObjectMeta } from '@sm/metadata';
import { fieldExpr } from '@sm/query-engine';
import { sql, type RawBuilder } from 'kysely';

/*
 * Rules-based lead scoring (§7.4, P03 T16). The primary model's FIT rules are Boolean formulas
 * worth points (fit, capped 0–100, also decides the grade A–D); its ENGAGEMENT rules give points
 * per event (form submissions and inbound emails now, activities from P04), each halving every
 * `engagement_half_life_days` (engagement, capped 0–100). Score = fit and engagement combined by
 * `fit_weight`, 1–100. Scores are derived columns: written without a version bump or audit (like
 * match keys), with a score_history row whenever they change.
 */

/** Rescore a tenant's leads after its model changed (emitted by Setup). */
export const SCORE_RECALC_TOPIC = 'maintenance.score_recalc';
/** Nightly, every tenant: engagement decays even when nothing happens. */
export const SCORE_NIGHTLY_TOPIC = 'maintenance.score_nightly';
export const SCORING_EVENTS = ['form_submission', 'inbound_email'] as const;
const DAY = 86_400_000;

interface Model {
  id: string;
  fitWeight: number;
  engagementHalfLifeDays: number;
  gradeBands: { A?: number; B?: number; C?: number };
  rules: {
    id: string;
    name: string;
    kind: 'FIT' | 'ENGAGEMENT';
    formula: string | null;
    event: string | null;
    points: number;
  }[];
}

export interface ScoreResult {
  recordId: string;
  fit: number;
  engagement: number;
  score: number;
  grade: string;
  changed: boolean;
}

/** A FIT rule's formula as SQL over the record alias `r`; null when it cannot run in SQL. */
function fitSql(
  metadata: MetadataIndex,
  object: ObjectMeta,
  formula: string,
  now: Date,
  timezone: string,
): RawBuilder<unknown> | null {
  const checked = checkFormula(
    formula,
    metadataEnvironment(metadata, object.apiName, { allowPriorValues: false }),
    'Boolean',
  );
  if (!checked.ok) return null;
  const compiled = compileToSql(checked.ast, {
    column: (path) => {
      const f = path.length === 1 ? object.fields.find((x) => x.apiName === path[0]) : undefined;
      return f ? fieldExpr('r', f) : null;
    },
    global: () => null,
    now,
    timezone,
  });
  return compiled.ok ? sql`COALESCE(${compiled.sql}, FALSE)` : null;
}

/** Why a FIT formula cannot be used (Setup); null when fine. */
export function fitRuleError(
  metadata: MetadataIndex,
  objectName: string,
  formula: string,
): string | null {
  const object = metadata.object(objectName);
  if (!object) return 'unknown_object';
  return fitSql(metadata, object, formula, new Date(), 'UTC') ? null : 'invalid_formula';
}

export const gradeOf = (fit: number, bands: Model['gradeBands']) =>
  fit >= (bands.A ?? 75) ? 'a' : fit >= (bands.B ?? 50) ? 'b' : fit >= (bands.C ?? 25) ? 'c' : 'd';

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

async function primaryModel(tx: TenantTransaction, object: string): Promise<Model | null> {
  const row = await tx.prisma.scoringModel.findFirst({
    where: { object, isPrimary: true, active: true },
    include: {
      rules: { where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] },
    },
  });
  return row ? { ...row, gradeBands: row.gradeBands as Model['gradeBands'] } : null;
}

/**
 * Recompute the primary model's scores for these leads (one statement for fit, one for events)
 * and write the ones that changed. Converted and deleted leads are left alone. Returns every
 * record scored; none when the object has no primary model.
 */
export async function scoreRecords(
  tx: TenantTransaction,
  env: { metadata: MetadataIndex; timezone: string; now?: () => Date },
  objectName: string,
  recordIds: readonly string[],
): Promise<ScoreResult[]> {
  const object = env.metadata.object(objectName);
  if (!object || objectName !== 'lead' || recordIds.length === 0) return [];
  const model = await primaryModel(tx, objectName);
  if (!model) return [];
  const now = env.now?.() ?? new Date();
  const tenantId = tx.context.tenantId;
  const fitRules = model.rules
    .filter((r) => r.kind === 'FIT' && r.formula)
    .flatMap((r) => {
      const expr = fitSql(env.metadata, object, r.formula ?? '', now, env.timezone);
      return expr ? [{ rule: r, expr }] : [];
    });
  const matched = fitRules.length
    ? sql.join(fitRules.map(({ rule, expr }) => sql`CASE WHEN ${expr} THEN ${rule.id}::text END`))
    : sql`NULL::text`;
  const rows = await sql<{
    id: string;
    fit_score: string | null;
    engagement_score: string | null;
    score: string | null;
    grade: string | null;
    hits: (string | null)[];
  }>`
    SELECT r.id, r.fit_score::text, r.engagement_score::text, r.score::text, r.grade,
      ARRAY[${matched}] AS hits
    FROM lead AS r
    WHERE r.tenant_id = ${tenantId}::uuid AND r.id = ANY (${sql.val([...recordIds])}::uuid[])
      AND r.deleted_at IS NULL AND r.converted_at IS NULL`.execute(tx.kysely);
  if (rows.rows.length === 0) return [];
  const ids = rows.rows.map((r) => r.id);

  // Engagement events, decayed by age.
  const engagementRules = model.rules.filter((r) => r.kind === 'ENGAGEMENT' && r.event);
  const events = engagementRules.length
    ? (
        await sql<{ record_id: string; event: string; at: Date }>`
          SELECT record_id, 'form_submission' AS event, received_at AS at FROM web_form_submission
          WHERE tenant_id = ${tenantId}::uuid AND record_id = ANY (${sql.val(ids)}::uuid[])
          UNION ALL
          SELECT record_id, 'inbound_email', received_at FROM inbound_email
          WHERE tenant_id = ${tenantId}::uuid AND record_id = ANY (${sql.val(ids)}::uuid[])`.execute(
          tx.kysely,
        )
      ).rows
    : [];
  const halfLife = model.engagementHalfLifeDays * DAY;

  const results: ScoreResult[] = [];
  const history: {
    recordId: string;
    fit: number;
    engagement: number;
    score: number;
    grade: string;
    reason: string[];
  }[] = [];
  for (const row of rows.rows) {
    const hits = new Set(row.hits.filter((h): h is string => h !== null));
    const fitRulesHit = fitRules.filter(({ rule }) => hits.has(rule.id));
    const fit = clamp(
      fitRulesHit.reduce((n, { rule }) => n + rule.points, 0),
      0,
      100,
    );
    let engagementRaw = 0;
    const reasons = fitRulesHit.map(({ rule }) => rule.name);
    for (const rule of engagementRules) {
      const own = events.filter((e) => e.record_id === row.id && e.event === rule.event);
      for (const e of own) {
        const age = Math.max(0, now.getTime() - new Date(e.at).getTime());
        engagementRaw += rule.points * Math.pow(0.5, age / halfLife);
      }
      if (own.length) reasons.push(`${rule.name} ×${String(own.length)}`);
    }
    const engagement = clamp(Math.round(engagementRaw), 0, 100);
    const score = clamp(
      Math.round((fit * model.fitWeight + engagement * (100 - model.fitWeight)) / 100),
      1,
      100,
    );
    const grade = gradeOf(fit, model.gradeBands);
    const changed =
      Number(row.fit_score) !== fit ||
      Number(row.engagement_score) !== engagement ||
      Number(row.score) !== score ||
      row.grade !== grade ||
      row.score === null;
    results.push({ recordId: row.id, fit, engagement, score, grade, changed });
    if (changed) history.push({ recordId: row.id, fit, engagement, score, grade, reason: reasons });
  }

  if (history.length) {
    const values = sql.join(
      history.map(
        (h) =>
          sql`(${h.recordId}::uuid, ${h.fit}::int, ${h.engagement}::int, ${h.score}::int, ${h.grade}::text)`,
      ),
    );
    await sql`UPDATE lead AS r SET fit_score = v.fit, engagement_score = v.engagement, score = v.score, grade = v.grade
      FROM (VALUES ${values}) AS v (id, fit, engagement, score, grade)
      WHERE r.tenant_id = ${tenantId}::uuid AND r.id = v.id`.execute(tx.kysely);
    await tx.prisma.scoreHistory.createMany({
      data: history.map((h) => ({
        tenantId,
        object: objectName,
        recordId: h.recordId,
        modelId: model.id,
        fit: h.fit,
        engagement: h.engagement,
        score: h.score,
        // History keeps the grade letter (A–D); the lead's picklist value is lower case.
        grade: h.grade.toUpperCase(),
        reason: h.reason,
      })),
    });
  }
  return results;
}

/**
 * Score every live lead of a tenant (nightly decay, or after the model changed), a keyset batch
 * per transaction. Returns the leads whose scores changed.
 */
export async function rescoreAll(
  inTenant: <T>(fn: (tx: TenantTransaction) => Promise<T>) => Promise<T>,
  env: { metadata: MetadataIndex; timezone: string; now?: () => Date },
  options: { batch?: number } = {},
): Promise<number> {
  const batch = options.batch ?? 1000;
  let after = '00000000-0000-0000-0000-000000000000';
  let changed = 0;
  for (;;) {
    const step = await inTenant(async (tx) => {
      const ids = (
        await sql<{ id: string }>`SELECT id FROM lead WHERE tenant_id = ${tx.context.tenantId}::uuid
          AND id > ${after}::uuid AND deleted_at IS NULL AND converted_at IS NULL
          ORDER BY id LIMIT ${batch}`.execute(tx.kysely)
      ).rows.map((r) => r.id);
      const results = await scoreRecords(tx, env, 'lead', ids);
      return { ids, changed: results.filter((r) => r.changed).length, scored: results.length };
    });
    changed += step.changed;
    const last = step.ids.at(-1);
    // No primary model: nothing scores, stop at once.
    if (!last || step.ids.length < batch || step.scored === 0) break;
    after = last;
  }
  return changed;
}
