import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupFixture, type SetupFixture } from './setup-fixture.js';

let f: SetupFixture;
type Json = Record<string, unknown>;
const json = (res: { body: string }) => JSON.parse(res.body) as Json;
const firstError = (res: { body: string }) => (json(res)['errors'] as Json[] | undefined)?.[0];

beforeAll(async () => {
  f = await setupFixture('assign');
});

afterAll(async () => {
  await f.api.dispose();
});

const roundRobin = () => ({
  method: 'ROUND_ROBIN',
  members: [
    { type: 'USER', id: f.id('rep') },
    { type: 'USER', id: f.id('peer') },
  ],
});
async function createRule(payload: Json = {}) {
  const res = await f.call('admin', 'POST', '/v1/setup/assignment-rules', {
    object: 'lead',
    name: `Rule ${String(Math.random()).slice(2, 8)}`,
    entries: [roundRobin()],
    ...payload,
  });
  expect(res.statusCode, res.body).toBe(201);
  return json(res) as Json & { id: string; version: number; entries: Json[] };
}
async function lead(user: string, fields: Json = {}) {
  const res = await f.call(user, 'POST', '/v1/records/lead', {
    fields: { last_name: 'Routed', company: 'R', ...fields },
  });
  expect(res.statusCode, res.body).toBe(201);
  return json(res)['id'] as string;
}

describe('Setup → assignment rules', () => {
  it('creates, changes and deletes rules with entries and pools, one default, audited', async () => {
    const a = await createRule({ name: 'Inbound', isDefault: true });
    expect(a).toMatchObject({ isDefault: true, object: 'lead' });
    expect(a.entries[0]).toMatchObject({
      method: 'ROUND_ROBIN',
      members: [
        { type: 'USER', id: f.id('rep'), weight: 1 },
        { type: 'USER', id: f.id('peer'), weight: 1 },
      ],
    });
    const b = await createRule({ isDefault: true });
    expect(json(await f.call('viewer', 'GET', `/v1/setup/assignment-rules/${a.id}`))).toMatchObject(
      {
        isDefault: false,
      },
    );
    const changed = await f.call('admin', 'PATCH', `/v1/setup/assignment-rules/${b.id}`, {
      entries: [
        {
          method: 'SPECIFIC_USER',
          criteria: { field: 'city', op: 'eq', value: 'Doha' },
          targetUserId: f.id('rep'),
        },
        {
          method: 'WEIGHTED',
          formula: "ISPICKVAL(lead_source, 'web')",
          members: [{ type: 'USER', id: f.id('peer'), weight: 3 }],
        },
      ],
      version: b.version,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect((json(changed)['entries'] as Json[]).map((e) => e['method'])).toEqual([
      'SPECIFIC_USER',
      'WEIGHTED',
    ]);
    expect(
      (
        await f.call('admin', 'PATCH', `/v1/setup/assignment-rules/${b.id}`, {
          name: 'X',
          version: 1,
        })
      ).statusCode,
    ).toBe(409);
    expect((await f.call('admin', 'DELETE', `/v1/setup/assignment-rules/${a.id}`)).statusCode).toBe(
      204,
    );
    const audited = await f.inTenant((tx) =>
      tx.prisma.setupAudit.count({ where: { entityType: 'assignment_rule' } }),
    );
    expect(audited).toBeGreaterThanOrEqual(4);
  });

  it('refuses entries that cannot run', async () => {
    const post = (entries: Json[], extra: Json = {}) =>
      f.call('admin', 'POST', '/v1/setup/assignment-rules', {
        object: 'lead',
        name: 'Bad',
        entries,
        ...extra,
      });
    expect(firstError(await post([{ method: 'SPECIFIC_USER' }]))).toMatchObject({
      code: 'required',
    });
    expect(firstError(await post([{ method: 'QUEUE' }]))).toMatchObject({
      field: 'entries.0.targetQueueId',
    });
    expect(firstError(await post([{ method: 'ROUND_ROBIN' }]))).toMatchObject({
      field: 'entries.0.members',
    });
    expect(firstError(await post([{ ...roundRobin(), formula: 'NOPE(' }]))).toMatchObject({
      code: 'invalid_formula',
    });
    expect(
      firstError(
        await post([{ ...roundRobin(), criteria: { field: 'nope', op: 'eq', value: 1 } }]),
      ),
    ).toMatchObject({
      code: 'invalid_criteria',
    });
    expect(
      firstError(
        await post([{ method: 'ROUND_ROBIN', members: [{ type: 'USER', id: f.id('outsider') }] }]),
      ),
    ).toMatchObject({ code: 'invalid_reference' });
    expect((await post([{ method: 'TELEPATHY' }])).statusCode).toBe(400);
    await createRule({ name: 'Taken' });
    expect((await post([roundRobin()], { name: 'Taken' })).statusCode).toBe(409);
  });

  it('is guarded like the rest of Setup', async () => {
    const r = await createRule();
    await f.expectGuarded('GET', '/v1/setup/assignment-rules', {});
    await f.expectGuarded('GET', `/v1/setup/assignment-rules/${r.id}`, {});
    await f.expectGuarded('POST', '/v1/setup/assignment-rules', {
      payload: { object: 'lead', name: 'G', entries: [] },
    });
    await f.expectGuarded('PATCH', `/v1/setup/assignment-rules/${r.id}`, {
      payload: { name: 'G2', version: 1 },
    });
    await f.expectGuarded('DELETE', `/v1/setup/assignment-rules/${r.id}`, {});
  });
});

describe('running rules and explaining them', () => {
  it('runs a rule on records and explains the decision on each record', async () => {
    const rule = await createRule({ name: 'Run me' });
    const ids = [await lead('admin'), await lead('admin')];
    const res = await f.call('admin', 'POST', '/v1/assignment/run', {
      object: 'lead',
      recordIds: ids,
      ruleId: rule.id,
    });
    expect(res.statusCode, res.body).toBe(200);
    const results = json(res)['results'] as Json[];
    expect(results.map((r) => r['ok'])).toEqual([true, true]);
    expect(new Set(results.map((r) => r['ownerId']))).toEqual(new Set([f.id('rep'), f.id('peer')]));
    const mine = results.find((r) => r['ownerId'] === f.id('rep'))?.['recordId'] as string;
    const why = await f.call('rep', 'GET', `/v1/records/lead/${mine}/assignment`);
    expect(why.statusCode, why.body).toBe(200);
    expect((json(why)['items'] as Json[])[0]).toMatchObject({
      method: 'ROUND_ROBIN',
      owner: { type: 'USER', id: f.id('rep'), name: 'rep' },
      source: 'run',
      rule: { id: rule.id, name: 'Run me' },
      reason: expect.stringContaining('round robin') as unknown,
    });
    // peer cannot see rep's lead.
    expect((await f.call('peer', 'GET', `/v1/records/lead/${mine}/assignment`)).statusCode).toBe(
      404,
    );
    expect(
      (await f.call('outsider', 'GET', `/v1/records/lead/${mine}/assignment`)).statusCode,
    ).toBe(404);
  });

  it('needs transfer_records, validates, and reports records the caller cannot reassign', async () => {
    const ids = [await lead('admin')];
    expect(
      (await f.call('rep', 'POST', '/v1/assignment/run', { object: 'lead', recordIds: ids }))
        .statusCode,
    ).toBe(403);
    expect(
      (await f.call('admin', 'POST', '/v1/assignment/run', { object: 'lead', recordIds: [] }))
        .statusCode,
    ).toBe(400);
    expect(
      (await f.call('admin', 'POST', '/v1/assignment/run', { object: 'campaign', recordIds: ids }))
        .statusCode,
    ).toBe(400);
    const other = await f.call('outsider', 'POST', '/v1/assignment/run', {
      object: 'lead',
      recordIds: ids,
    });
    expect(json(other)['results']).toEqual([{ recordId: ids[0], ok: false, error: 'not_found' }]);
  });
});
