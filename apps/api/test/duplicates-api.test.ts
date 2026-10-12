import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupFixture, type SetupFixture } from './setup-fixture.js';

let f: SetupFixture;
type Json = Record<string, unknown>;
const json = (res: { body: string }) => JSON.parse(res.body) as Json;

beforeAll(async () => {
  f = await setupFixture('dedupe');
});

afterAll(async () => {
  await f.api.dispose();
});

async function lead(user: string, fields: Json) {
  const res = await f.call(user, 'POST', '/v1/records/lead', { fields });
  expect(res.statusCode, res.body).toBe(201);
  return json(res)['id'] as string;
}

async function matchingRule(payload: Json = {}) {
  const res = await f.call('admin', 'POST', '/v1/setup/matching-rules', {
    object: 'lead',
    name: `Email ${String(Math.random()).slice(2, 8)}`,
    conditions: [{ field: 'email', method: 'email' }],
    ...payload,
  });
  expect(res.statusCode, res.body).toBe(201);
  return json(res) as Json & { id: string; version: number };
}

async function duplicateRule(matchingRuleId: string, payload: Json = {}) {
  const res = await f.call('admin', 'POST', '/v1/setup/duplicate-rules', {
    object: 'lead',
    name: `Rule ${String(Math.random()).slice(2, 8)}`,
    matchingRuleId,
    ...payload,
  });
  expect(res.statusCode, res.body).toBe(201);
  return json(res) as Json & { id: string; version: number };
}

const firstError = (res: { body: string }) => (json(res)['errors'] as Json[] | undefined)?.[0];

describe('Setup → matching rules', () => {
  it('creates, reads, changes and deletes a rule, audited', async () => {
    const rule = await matchingRule({
      name: 'Company and surname',
      conditions: [
        { field: 'company', method: 'company' },
        { field: 'last_name', method: 'fuzzy', threshold: 0.6 },
      ],
    });
    expect(rule).toMatchObject({ object: 'lead', active: true, matchBlank: false, usedBy: 0 });
    const got = await f.call('viewer', 'GET', `/v1/setup/matching-rules/${rule.id}`);
    expect(json(got)).toMatchObject({ name: 'Company and surname' });
    const listed = await f.call('viewer', 'GET', '/v1/setup/matching-rules');
    expect((json(listed)['items'] as Json[]).map((r) => r['id'])).toContain(rule.id);
    const changed = await f.call('admin', 'PATCH', `/v1/setup/matching-rules/${rule.id}`, {
      matchBlank: true,
      version: rule.version,
    });
    expect(json(changed)).toMatchObject({ matchBlank: true, version: rule.version + 1 });
    const stale = await f.call('admin', 'PATCH', `/v1/setup/matching-rules/${rule.id}`, {
      name: 'X',
      version: rule.version,
    });
    expect(stale.statusCode).toBe(409);
    expect(
      (await f.call('admin', 'DELETE', `/v1/setup/matching-rules/${rule.id}`)).statusCode,
    ).toBe(204);
    const actions = await f.inTenant((tx) =>
      tx.prisma.setupAudit.findMany({ where: { entityId: rule.id }, select: { action: true } }),
    );
    expect(actions.map((a) => a.action).sort()).toEqual([
      'matching_rule.created',
      'matching_rule.deleted',
      'matching_rule.updated',
    ]);
  });

  it('refuses conditions that cannot run, and taken names', async () => {
    const post = (payload: Json) =>
      f.call('admin', 'POST', '/v1/setup/matching-rules', {
        object: 'lead',
        name: 'Bad',
        ...payload,
      });
    expect(
      firstError(await post({ conditions: [{ field: 'title', method: 'fuzzy' }] })),
    ).toMatchObject({
      code: 'needs_keyed_condition',
    });
    expect(
      firstError(await post({ conditions: [{ field: 'nope', method: 'exact' }] })),
    ).toMatchObject({
      field: 'conditions.0.field',
      code: 'unknown_field',
    });
    expect(
      firstError(await post({ conditions: [{ field: 'city', method: 'phone' }] })),
    ).toMatchObject({
      code: 'not_for_field',
    });
    expect((await post({ conditions: [] })).statusCode).toBe(400);
    expect(
      (await post({ object: 'opportunity', conditions: [{ field: 'name', method: 'exact' }] }))
        .statusCode,
    ).toBe(400);
    const taken = await matchingRule({ name: 'Taken' });
    expect(taken.id).toBeDefined();
    expect(
      (await post({ name: 'Taken', conditions: [{ field: 'email', method: 'email' }] })).statusCode,
    ).toBe(409);
  });

  it('is guarded: view_setup reads, customize_application changes, other workspaces see nothing', async () => {
    const rule = await matchingRule();
    await f.expectGuarded('GET', '/v1/setup/matching-rules', {});
    await f.expectGuarded('GET', `/v1/setup/matching-rules/${rule.id}`, {});
    await f.expectGuarded('POST', '/v1/setup/matching-rules', {
      payload: { object: 'lead', name: 'G', conditions: [{ field: 'email', method: 'email' }] },
    });
    await f.expectGuarded('PATCH', `/v1/setup/matching-rules/${rule.id}`, {
      payload: { name: 'G2', version: 1 },
    });
    await f.expectGuarded('POST', `/v1/setup/matching-rules/${rule.id}/test`, {
      payload: { fields: { email: 'x@y.example' } },
      reader: true,
    });
    await f.expectGuarded('DELETE', `/v1/setup/matching-rules/${rule.id}`, {});
  });

  it('previews what a rule finds for typed values or a record', async () => {
    const email = 'preview@dedupe.example';
    const id = await lead('rep', { last_name: 'Preview', company: 'P', email });
    const rule = await matchingRule();
    const typed = await f.call('admin', 'POST', `/v1/setup/matching-rules/${rule.id}/test`, {
      fields: { email: email.toUpperCase() },
    });
    expect(typed.statusCode, typed.body).toBe(200);
    expect(json(typed)['matches']).toEqual([{ id, name: 'Preview', score: 1 }]);
    const fromRecord = await f.call('admin', 'POST', `/v1/setup/matching-rules/${rule.id}/test`, {
      recordId: id,
    });
    // A record never matches itself.
    expect(json(fromRecord)['matches']).toEqual([]);
    const both = await f.call('admin', 'POST', `/v1/setup/matching-rules/${rule.id}/test`, {
      recordId: id,
      fields: {},
    });
    expect(both.statusCode).toBe(400);
  });
});

describe('Setup → duplicate rules', () => {
  it('creates and changes rules, checking their references', async () => {
    const matching = await matchingRule();
    const rule = await duplicateRule(matching.id, {
      action: 'BLOCK',
      bypassProfileIds: [f.id('profile:admin')],
    });
    expect(rule).toMatchObject({
      action: 'BLOCK',
      onCreate: true,
      onEdit: true,
      matchingRule: { id: matching.id },
      bypassProfileIds: [f.id('profile:admin')],
    });
    const changed = await f.call('admin', 'PATCH', `/v1/setup/duplicate-rules/${rule.id}`, {
      action: 'ALERT',
      version: rule.version,
    });
    expect(json(changed)).toMatchObject({ action: 'ALERT' });
    // In use: the matching rule cannot go.
    expect(
      (await f.call('admin', 'DELETE', `/v1/setup/matching-rules/${matching.id}`)).statusCode,
    ).toBe(409);
    expect(
      (await f.call('admin', 'DELETE', `/v1/setup/duplicate-rules/${rule.id}`)).statusCode,
    ).toBe(204);
  });

  it('refuses another object’s matching rule, unknown profiles and rules that never run', async () => {
    const contactRule = await matchingRule({ object: 'contact' });
    const leadRule = await matchingRule();
    const post = (payload: Json) =>
      f.call('admin', 'POST', '/v1/setup/duplicate-rules', {
        object: 'lead',
        name: 'Bad',
        matchingRuleId: leadRule.id,
        ...payload,
      });
    expect(firstError(await post({ matchingRuleId: contactRule.id }))).toMatchObject({
      field: 'matchingRuleId',
    });
    expect(firstError(await post({ bypassProfileIds: [f.id('admin')] }))).toMatchObject({
      field: 'bypassProfileIds',
    });
    expect(firstError(await post({ onCreate: false, onEdit: false }))).toMatchObject({
      field: 'onCreate',
    });
    expect((await post({ action: 'WARN' })).statusCode).toBe(400);
  });

  it('is guarded like the rest of Setup', async () => {
    const matching = await matchingRule();
    const rule = await duplicateRule(matching.id);
    await f.expectGuarded('GET', '/v1/setup/duplicate-rules', {});
    await f.expectGuarded('GET', `/v1/setup/duplicate-rules/${rule.id}`, {});
    await f.expectGuarded('POST', '/v1/setup/duplicate-rules', {
      payload: { object: 'lead', name: 'G', matchingRuleId: matching.id },
    });
    await f.expectGuarded('PATCH', `/v1/setup/duplicate-rules/${rule.id}`, {
      payload: { name: 'G2', version: 1 },
    });
    await f.expectGuarded('DELETE', `/v1/setup/duplicate-rules/${rule.id}`, {});
  });
});

describe('duplicate checks on records', () => {
  it('checks typed values: visible matches by rule, and whether a save is blocked', async () => {
    await f.inTenant(async ({ prisma: p }) => {
      await p.duplicateRule.deleteMany({});
    });
    const email = 'check@dedupe.example';
    const mine = await lead('rep', { last_name: 'Mine', company: 'C', email });
    // peer's: private, rep cannot see it.
    await lead('peer', { last_name: 'Theirs', company: 'C', email: 'hidden@dedupe.example' });
    const alert = await duplicateRule((await matchingRule()).id, { action: 'ALERT' });
    const check = (fields: Json, user = 'rep', extra: Json = {}) =>
      f.call(user, 'POST', '/v1/records/lead/duplicates/check', { fields, ...extra });

    const res = await check({ email: ` ${email.toUpperCase()}` });
    expect(res.statusCode, res.body).toBe(200);
    expect(json(res)).toEqual({
      blocked: false,
      groups: [
        {
          ruleId: alert.id,
          rule: alert['name'],
          action: 'ALERT',
          matches: [{ id: mine, name: 'Mine', score: 1 }],
        },
      ],
    });
    // Editing that record: it does not match itself.
    expect(json(await check({ email }, 'rep', { id: mine }))).toEqual({
      blocked: false,
      groups: [],
    });

    await duplicateRule((await matchingRule()).id, { action: 'BLOCK' });
    // Blocked by a record rep cannot see: said, never shown.
    expect(json(await check({ email: 'hidden@dedupe.example' }))).toEqual({
      blocked: true,
      groups: [],
    });
    const save = await f.call('rep', 'POST', '/v1/records/lead', {
      fields: { last_name: 'Again', company: 'C', email: 'hidden@dedupe.example' },
    });
    expect(save.statusCode).toBe(409);
    expect(firstError(save)).toMatchObject({ code: 'duplicate_blocked' });
    await f.inTenant(async ({ prisma: p }) => {
      await p.duplicateRule.deleteMany({});
    });
  });

  it('validates the object and the record, and keeps other workspaces out', async () => {
    const id = await lead('rep', { last_name: 'Own', company: 'C' });
    const post = (object: string, payload: Json, user = 'rep') =>
      f.call(user, 'POST', `/v1/records/${object}/duplicates/check`, payload);
    expect((await post('opportunity', { fields: {} })).statusCode).toBe(400);
    expect((await post('lead', { fields: { email: 'x' }, extra: 1 })).statusCode).toBe(400);
    // Another user's private record, and another workspace's record: 404.
    const theirs = await lead('peer', { last_name: 'Peer', company: 'C' });
    expect((await post('lead', { fields: {}, id: theirs })).statusCode).toBe(404);
    expect((await post('lead', { fields: {}, id }, 'outsider')).statusCode).toBe(404);
    expect((await f.call('outsider', 'GET', `/v1/records/lead/${id}/duplicates`)).statusCode).toBe(
      404,
    );
  });

  it('lists a record’s potential duplicates under readable rules', async () => {
    await f.inTenant(async ({ prisma: p }) => {
      await p.duplicateRule.deleteMany({});
    });
    const email = 'potential@dedupe.example';
    const a = await lead('rep', { last_name: 'A', company: 'Potential', email });
    const b = await lead('rep', { last_name: 'B', company: 'Potential', email });
    const rule = await duplicateRule((await matchingRule()).id);
    const res = await f.call('rep', 'GET', `/v1/records/lead/${a}/duplicates`);
    expect(res.statusCode, res.body).toBe(200);
    expect(json(res)['groups']).toEqual([
      {
        ruleId: rule.id,
        rule: rule['name'],
        action: 'ALERT',
        matches: [{ id: b, name: 'B', score: 1 }],
      },
    ]);
    expect((await f.call('rep', 'GET', '/v1/records/lead/not-a-uuid/duplicates')).statusCode).toBe(
      400,
    );
    const theirs = await lead('peer', { last_name: 'P', company: 'Potential', email });
    expect((await f.call('rep', 'GET', `/v1/records/lead/${theirs}/duplicates`)).statusCode).toBe(
      404,
    );
    await f.inTenant(async ({ prisma: p }) => {
      await p.duplicateRule.deleteMany({});
    });
  });
});

describe('merge', () => {
  const merge = (user: string, object: string, payload: Json) =>
    f.call(user, 'POST', `/v1/records/${object}/merge`, payload);

  it('merges leads: the survivor keeps chosen values, the other goes to the bin', async () => {
    const a = await lead('rep', { last_name: 'Keep', company: 'Merge Co' });
    const b = await lead('rep', {
      last_name: 'Gone',
      company: 'Merge Co',
      email: 'm@merge.example',
    });
    const res = await merge('rep', 'lead', {
      masterId: a,
      duplicateIds: [b],
      fields: { email: b },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(json(res)).toMatchObject({ id: a, merged: [b] });
    const kept = await f.call('rep', 'GET', `/v1/records/lead/${a}`);
    expect(json(kept)).toMatchObject({ last_name: 'Keep', email: 'm@merge.example' });
    expect((await f.call('rep', 'GET', `/v1/records/lead/${b}`)).statusCode).toBe(404);
    const history = await f.call('rep', 'GET', `/v1/records/lead/${a}/history`);
    expect(JSON.stringify(json(history)['items'])).toContain('_merged');
  });

  it('validates the request', async () => {
    const a = await lead('rep', { last_name: 'V', company: 'C' });
    expect((await merge('rep', 'lead', { masterId: a, duplicateIds: [] })).statusCode).toBe(400);
    expect((await merge('rep', 'opportunity', { masterId: a, duplicateIds: [a] })).statusCode).toBe(
      400,
    );
    expect((await merge('rep', 'lead', { masterId: a, duplicateIds: [a] })).statusCode).toBe(400);
    const b = await lead('rep', { last_name: 'V2', company: 'C' });
    const stale = await merge('rep', 'lead', { masterId: a, duplicateIds: [b], version: 99 });
    expect(stale.statusCode).toBe(409);
  });

  it('needs Delete with Full access on the merged records', async () => {
    const mine = await lead('rep', { last_name: 'Mine', company: 'C' });
    const shared = await lead('admin', { last_name: 'Shared', company: 'C' });
    // Read/Write shared with rep: visible and editable, not deletable by rep.
    await f.inTenant(async ({ prisma: p }) => {
      await p.recordShare.create({
        data: {
          tenantId: f.tenantId,
          object: 'lead',
          recordId: shared,
          principalType: 'USER',
          principalId: f.id('rep'),
          access: 2,
          reason: 'MANUAL',
          sourceId: '00000000-0000-0000-0000-000000000000',
        },
      });
    });
    const res = await merge('rep', 'lead', { masterId: mine, duplicateIds: [shared] });
    expect(res.statusCode).toBe(403);
    expect(firstError(res)).toMatchObject({ code: 'cannot_delete' });
  });

  it('keeps other workspaces out (404)', async () => {
    const a = await lead('rep', { last_name: 'X1', company: 'C' });
    const b = await lead('rep', { last_name: 'X2', company: 'C' });
    expect((await merge('outsider', 'lead', { masterId: a, duplicateIds: [b] })).statusCode).toBe(
      404,
    );
  });
});

describe('duplicate jobs and the review queue', () => {
  it('queues a scan job (admin) and lists jobs (view_setup)', async () => {
    const rule = await matchingRule();
    const res = await f.call('admin', 'POST', '/v1/duplicate-jobs', {
      matchingRuleId: rule.id,
      schedule: 'weekly',
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(json(res)).toMatchObject({ status: 'QUEUED', schedule: 'weekly', object: 'lead' });
    const events = await f.inTenant((tx) =>
      tx.prisma.outboxEvent.count({ where: { topic: 'maintenance.duplicate_scan' } }),
    );
    expect(events).toBeGreaterThan(0);
    const listed = await f.call('viewer', 'GET', '/v1/duplicate-jobs');
    expect((json(listed)['items'] as Json[]).map((j) => j['id'])).toContain(json(res)['id']);
    expect(
      firstError(
        await f.call('admin', 'POST', '/v1/duplicate-jobs', {
          matchingRuleId: f.id('admin'),
        }),
      ),
    ).toMatchObject({ field: 'matchingRuleId' });
    expect(
      (
        await f.call('admin', 'POST', '/v1/duplicate-jobs', {
          matchingRuleId: rule.id,
          schedule: 'hourly',
        })
      ).statusCode,
    ).toBe(400);
    await f.expectGuarded('GET', '/v1/duplicate-jobs', {});
    await f.expectGuarded('POST', '/v1/duplicate-jobs', { payload: { matchingRuleId: rule.id } });
    const outsider = await f.call('outsider', 'GET', '/v1/duplicate-jobs');
    expect(json(outsider)['items']).toEqual([]);
  });

  it('shows groups whose records the caller can all see, and dismisses them', async () => {
    const mine1 = await lead('rep', { last_name: 'Q1', company: 'Queue' });
    const mine2 = await lead('rep', { last_name: 'Q2', company: 'Queue' });
    const theirs = await lead('peer', { last_name: 'Q3', company: 'Queue' });
    const group = (a: string, b: string, score: number) => {
      const ids = [a, b].sort();
      return {
        tenantId: f.tenantId,
        object: 'lead',
        recordIds: ids,
        groupKey: ids.join(','),
        score,
      };
    };
    await f.inTenant((tx) =>
      tx.prisma.duplicateCandidate.createMany({
        data: [group(mine1, mine2, 0.9), group(mine1, theirs, 1)],
      }),
    );
    const res = await f.call('rep', 'GET', '/v1/duplicate-candidates?object=lead&limit=1');
    expect(res.statusCode, res.body).toBe(200);
    const items = json(res)['items'] as (Json & { id: string; records: Json[] })[];
    expect(items).toHaveLength(1);
    expect(items[0]?.records.map((r) => r['name']).sort()).toEqual(['Q1', 'Q2']);
    expect(json(res)['nextCursor']).toBeNull();
    // The admin sees both groups, best first, a page at a time.
    const first = await f.call('admin', 'GET', '/v1/duplicate-candidates?object=lead&limit=1');
    expect(json(first)['nextCursor']).not.toBeNull();
    const second = await f.call(
      'admin',
      'GET',
      `/v1/duplicate-candidates?object=lead&limit=1&cursor=${encodeURIComponent(String(json(first)['nextCursor']))}`,
    );
    expect((json(second)['items'] as Json[]).length).toBe(1);

    const id = items[0]?.id ?? '';
    expect(
      (await f.call('outsider', 'POST', `/v1/duplicate-candidates/${id}/dismiss`)).statusCode,
    ).toBe(404);
    const theirGroup = (json(first)['items'] as Json[])[0]?.['id'] as string;
    expect(
      (await f.call('rep', 'POST', `/v1/duplicate-candidates/${theirGroup}/dismiss`)).statusCode,
    ).toBe(404);
    const dismissed = await f.call('rep', 'POST', `/v1/duplicate-candidates/${id}/dismiss`);
    expect(dismissed.statusCode, dismissed.body).toBe(200);
    expect(json(dismissed)).toMatchObject({ status: 'DISMISSED' });
    expect((await f.call('rep', 'POST', `/v1/duplicate-candidates/${id}/dismiss`)).statusCode).toBe(
      409,
    );
    expect(
      (await f.call('rep', 'GET', '/v1/duplicate-candidates?object=lead&cursor=bad|x')).statusCode,
    ).toBe(400);
    expect(
      (await f.call('rep', 'GET', '/v1/duplicate-candidates?object=opportunity')).statusCode,
    ).toBe(400);
    const left = await f.call('rep', 'GET', '/v1/duplicate-candidates?object=lead');
    expect(json(left)['items']).toEqual([]);
  });
});
