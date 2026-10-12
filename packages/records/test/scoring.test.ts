import type { TenantTransaction } from '@sm/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRecord,
  fitRuleError,
  gradeOf,
  readStored,
  rescoreAll,
  scoreRecords,
  updateRecord,
  type RecordContext,
} from '../src/index.js';
import { startHarness, type Harness } from './support.js';

const T = '01920000-0000-7000-8000-000000000d0f';
let h: Harness;
let rep = '';
let form = '';
const DAY = 86_400_000;
/** The harness clock. */
const NOW = new Date('2026-09-27T10:00:00Z');

beforeAll(async () => {
  h = await startHarness(T);
  rep = await h.user('rep');
  await h.inTenant(async ({ prisma: p }) => {
    const model = await p.scoringModel.create({
      data: {
        tenantId: T,
        name: 'Default',
        isPrimary: true,
        fitWeight: 60,
        engagementHalfLifeDays: 14,
      },
    });
    await p.scoringRule.createMany({
      data: [
        {
          tenantId: T,
          modelId: model.id,
          kind: 'FIT',
          name: 'Tech',
          formula: "ISPICKVAL(industry, 'technology')",
          points: 40,
        },
        {
          tenantId: T,
          modelId: model.id,
          kind: 'FIT',
          name: 'Has email',
          formula: 'NOT(ISBLANK(email))',
          points: 30,
        },
        {
          tenantId: T,
          modelId: model.id,
          kind: 'FIT',
          name: 'Large',
          formula: 'number_of_employees > 100',
          points: 50,
        },
        {
          tenantId: T,
          modelId: model.id,
          kind: 'ENGAGEMENT',
          name: 'Form',
          event: 'form_submission',
          points: 20,
        },
      ],
    });
    form = (await p.webForm.create({ data: { tenantId: T, name: 'Contact us', runAsUserId: rep } }))
      .id;
  });
});

afterAll(async () => {
  await h.dispose();
});

const as = <R>(fn: (tx: TenantTransaction, ctx: RecordContext) => Promise<R>) =>
  h.inTenant(async (tx) => fn(tx, await h.context(tx, rep)));
const scores = (id: string) =>
  as(async (tx, ctx) => {
    const meta = ctx.metadata.object('lead');
    if (!meta) throw new Error('lead');
    const v = (await readStored(tx, meta, id))?.values ?? {};
    return [v['fit_score'], v['engagement_score'], v['score'], v['grade']];
  });

describe('rules-based scoring (§7.4)', () => {
  it('scores fit on every write: points capped at 100, grade from the bands', async () => {
    const { id } = await as((tx, ctx) =>
      createRecord(tx, ctx, 'lead', {
        fields: { last_name: 'Fit', company: 'C', industry: 'technology', email: 'a@b.example' },
      }),
    );
    // Fit 70 → B; no engagement: 70 × 0.6 = 42.
    expect(await scores(id)).toEqual(['70', '0', '42', 'b']);
    await as((tx, ctx) =>
      updateRecord(tx, ctx, 'lead', id, { fields: { number_of_employees: 500 } }, null),
    );
    expect(await scores(id)).toEqual(['100', '0', '60', 'a']);
    const history = await h.inTenant(({ prisma: p }) =>
      p.scoreHistory.findMany({ where: { recordId: id }, orderBy: { changedAt: 'asc' } }),
    );
    expect(history.map((x) => [x.fit, x.score, x.grade])).toEqual([
      [70, 42, 'B'],
      [100, 60, 'A'],
    ]);
    // In rule order (sort order, then name).
    expect(history[1]?.reason).toEqual(['Has email', 'Large', 'Tech']);
  });

  it('adds engagement that halves every half-life, and decays when rescored later', async () => {
    const { id } = await as((tx, ctx) =>
      createRecord(tx, ctx, 'lead', { fields: { last_name: 'Engaged', company: 'C' } }),
    );
    await h.inTenant(({ prisma: p }) =>
      p.webFormSubmission.createMany({
        data: [
          { tenantId: T, formId: form, payload: {}, recordId: id, receivedAt: NOW },
          {
            tenantId: T,
            formId: form,
            payload: {},
            recordId: id,
            receivedAt: new Date(NOW.getTime() - 14 * DAY),
          },
        ],
      }),
    );
    const [result] = await as((tx, ctx) =>
      scoreRecords(tx, { metadata: ctx.metadata, timezone: 'UTC', now: () => NOW }, 'lead', [id]),
    );
    // 20 + 20 × ½ = 30 engagement; fit 0 → D; 30 × 0.4 = 12.
    expect(result).toMatchObject({ fit: 0, engagement: 30, score: 12, grade: 'd', changed: true });
    // Unchanged: no new history.
    const again = await as((tx, ctx) =>
      scoreRecords(tx, { metadata: ctx.metadata, timezone: 'UTC', now: () => NOW }, 'lead', [id]),
    );
    expect(again[0]?.changed).toBe(false);
    // Four weeks on, nightly: 20 × ¼ + 20 × ⅛ = 7.5 → 8.
    const changed = await as((_tx, ctx) =>
      rescoreAll((fn) => h.inTenant(fn), {
        metadata: ctx.metadata,
        timezone: 'UTC',
        now: () => new Date(NOW.getTime() + 28 * DAY),
      }),
    );
    expect(changed).toBeGreaterThan(0);
    expect(await scores(id)).toEqual(['0', '8', '3', 'd']);
  });

  it('grades by band and refuses formulas that cannot run in SQL', async () => {
    expect([90, 75, 74, 50, 25, 24].map((n) => gradeOf(n, { A: 75, B: 50, C: 25 }))).toEqual([
      'a',
      'a',
      'b',
      'b',
      'c',
      'd',
    ]);
    const metadata = await as((_tx, ctx) => Promise.resolve(ctx.metadata));
    expect(fitRuleError(metadata, 'lead', 'NOPE(')).toBe('invalid_formula');
    expect(fitRuleError(metadata, 'lead', "ISPICKVAL(industry, 'technology')")).toBeNull();
  });
});
