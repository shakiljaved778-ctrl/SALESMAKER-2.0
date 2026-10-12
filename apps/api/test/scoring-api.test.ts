import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupFixture, type SetupFixture } from './setup-fixture.js';

let f: SetupFixture;
type Json = Record<string, unknown>;
const json = (res: { body: string }) => JSON.parse(res.body) as Json;
const firstError = (res: { body: string }) => (json(res)['errors'] as Json[] | undefined)?.[0];

beforeAll(async () => {
  f = await setupFixture('scoring');
});

afterAll(async () => {
  await f.api.dispose();
});

const rules = [
  { kind: 'FIT', name: 'Tech', formula: "ISPICKVAL(industry, 'technology')", points: 60 },
  { kind: 'ENGAGEMENT', name: 'Form', event: 'form_submission', points: 20 },
];
const create = async (payload: Json = {}) => {
  const res = await f.call('admin', 'POST', '/v1/setup/scoring-models', {
    name: `Model ${String(Math.random()).slice(2, 7)}`,
    rules,
    ...payload,
  });
  expect(res.statusCode, res.body).toBe(201);
  return json(res) as Json & { id: string; version: number };
};

describe('Setup → lead scoring', () => {
  it('creates models with rules, keeps one primary, and asks for a recalculation', async () => {
    const a = await create({ name: 'Default', isPrimary: true });
    expect(a).toMatchObject({
      isPrimary: true,
      fitWeight: 60,
      gradeBands: { A: 75, B: 50, C: 25 },
      rules: [
        expect.objectContaining({ kind: 'FIT', name: 'Tech', points: 60 }),
        expect.objectContaining({ kind: 'ENGAGEMENT', event: 'form_submission' }),
      ] as unknown,
    });
    const recalcs = await f.inTenant((tx) =>
      tx.prisma.outboxEvent.count({ where: { topic: 'maintenance.score_recalc' } }),
    );
    expect(recalcs).toBe(1);
    const b = await create({ isPrimary: true });
    expect(
      json(await f.call('viewer', 'GET', `/v1/setup/scoring-models/${a.id}`))['isPrimary'],
    ).toBe(false);
    const changed = await f.call('admin', 'PATCH', `/v1/setup/scoring-models/${b.id}`, {
      fitWeight: 80,
      rules: [rules[0]],
      version: b.version,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(json(changed)).toMatchObject({
      fitWeight: 80,
      rules: [expect.objectContaining({ name: 'Tech' })],
    });
    expect(
      (
        await f.call('admin', 'PATCH', `/v1/setup/scoring-models/${b.id}`, {
          name: 'X',
          version: 1,
        })
      ).statusCode,
    ).toBe(409);
    expect((await f.call('admin', 'DELETE', `/v1/setup/scoring-models/${a.id}`)).statusCode).toBe(
      204,
    );
  });

  it('refuses rules that cannot score and bad bands', async () => {
    const post = (payload: Json) =>
      f.call('admin', 'POST', '/v1/setup/scoring-models', { name: 'Bad', ...payload });
    expect(
      firstError(await post({ rules: [{ kind: 'FIT', name: 'X', points: 5 }] })),
    ).toMatchObject({
      field: 'rules.0.formula',
      code: 'required',
    });
    expect(
      firstError(await post({ rules: [{ kind: 'FIT', name: 'X', formula: 'NOPE(', points: 5 }] })),
    ).toMatchObject({
      code: 'invalid_formula',
    });
    expect(
      firstError(await post({ rules: [{ kind: 'ENGAGEMENT', name: 'X', points: 5 }] })),
    ).toMatchObject({
      field: 'rules.0.event',
    });
    expect(
      (await post({ rules: [{ kind: 'FIT', name: 'X', formula: 'TRUE', points: 500 }] }))
        .statusCode,
    ).toBe(400);
    expect((await post({ gradeBands: { A: 20, B: 50, C: 10 } })).statusCode).toBe(400);
    await create({ name: 'Taken' });
    expect((await post({ name: 'Taken' })).statusCode).toBe(409);
  });

  it('is guarded like the rest of Setup', async () => {
    const m = await create();
    await f.expectGuarded('GET', '/v1/setup/scoring-models', {});
    await f.expectGuarded('GET', `/v1/setup/scoring-models/${m.id}`, {});
    await f.expectGuarded('POST', '/v1/setup/scoring-models', { payload: { name: 'G' } });
    await f.expectGuarded('PATCH', `/v1/setup/scoring-models/${m.id}`, {
      payload: { name: 'G2', version: 1 },
    });
    await f.expectGuarded('DELETE', `/v1/setup/scoring-models/${m.id}`, {});
  });
});

describe('scores on leads', () => {
  it('scores on save and explains the history to whoever can see the lead', async () => {
    await f.inTenant((tx) => tx.prisma.scoringModel.deleteMany({}));
    await create({ name: 'Primary', isPrimary: true });
    const res = await f.call('rep', 'POST', '/v1/records/lead', {
      fields: { last_name: 'Scored', company: 'C', industry: 'technology' },
    });
    const id = json(res)['id'] as string;
    const lead = json(await f.call('rep', 'GET', `/v1/records/lead/${id}`));
    expect(lead).toMatchObject({ fit_score: '60', score: '36', grade: 'b' });
    const history = await f.call('rep', 'GET', `/v1/records/lead/${id}/score-history`);
    expect(history.statusCode, history.body).toBe(200);
    expect(json(history)['items']).toEqual([
      expect.objectContaining({ fit: 60, engagement: 0, score: 36, grade: 'B', reason: ['Tech'] }),
    ]);
    expect((await f.call('peer', 'GET', `/v1/records/lead/${id}/score-history`)).statusCode).toBe(
      404,
    );
    expect(
      (await f.call('outsider', 'GET', `/v1/records/lead/${id}/score-history`)).statusCode,
    ).toBe(404);
    expect(
      (await f.call('rep', 'GET', '/v1/records/lead/not-a-uuid/score-history')).statusCode,
    ).toBe(400);
  });
});
