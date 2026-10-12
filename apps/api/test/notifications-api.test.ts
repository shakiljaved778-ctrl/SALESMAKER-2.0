import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupFixture, type SetupFixture } from './setup-fixture.js';

let f: SetupFixture;
type Json = Record<string, unknown>;
const json = (res: { body: string }) => JSON.parse(res.body) as Json;

beforeAll(async () => {
  f = await setupFixture('notify');
  // Assigning to rep tells rep about it.
  const rule = await f.call('admin', 'POST', '/v1/setup/assignment-rules', {
    object: 'lead',
    name: 'To rep',
    entries: [{ method: 'SPECIFIC_USER', targetUserId: f.id('rep') }],
  });
  const ruleId = json(rule)['id'] as string;
  for (let i = 0; i < 3; i += 1) {
    const lead = await f.call('admin', 'POST', '/v1/records/lead', {
      fields: { last_name: `N${String(i)}`, company: 'C' },
    });
    await f.call('admin', 'POST', '/v1/assignment/run', {
      object: 'lead',
      recordIds: [json(lead)['id']],
      ruleId,
    });
  }
});

afterAll(async () => {
  await f.api.dispose();
});

describe('notifications (§7.18, P03)', () => {
  it('lists the caller’s own, latest first, a page at a time, with the unread count', async () => {
    const first = await f.call('rep', 'GET', '/v1/notifications?limit=2');
    expect(first.statusCode, first.body).toBe(200);
    const page = json(first) as { items: Json[]; unreadCount: number; nextCursor: string | null };
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      kind: 'assignment',
      object: 'lead',
      readAt: null,
      params: { method: 'SPECIFIC_USER' },
    });
    expect(page.unreadCount).toBe(3);
    const rest = await f.call(
      'rep',
      'GET',
      `/v1/notifications?limit=2&cursor=${encodeURIComponent(page.nextCursor ?? '')}`,
    );
    expect((json(rest)['items'] as Json[]).length).toBe(1);
    // Nobody else sees them.
    expect(json(await f.call('peer', 'GET', '/v1/notifications'))).toMatchObject({
      items: [],
      unreadCount: 0,
    });
    expect(json(await f.call('outsider', 'GET', '/v1/notifications'))).toMatchObject({
      items: [],
      unreadCount: 0,
    });
  });

  it('marks some or all read; others’ notifications are untouched', async () => {
    const list = json(await f.call('rep', 'GET', '/v1/notifications')) as { items: Json[] };
    const one = list.items[0]?.['id'] as string;
    // peer cannot mark rep's notifications read.
    expect(json(await f.call('peer', 'POST', '/v1/notifications/read', { ids: [one] }))).toEqual({
      updated: 0,
      unreadCount: 0,
    });
    expect(json(await f.call('rep', 'POST', '/v1/notifications/read', { ids: [one] }))).toEqual({
      updated: 1,
      unreadCount: 2,
    });
    const unread = json(await f.call('rep', 'GET', '/v1/notifications?unread=true'));
    expect((unread['items'] as Json[]).map((n) => n['id'])).not.toContain(one);
    expect(json(await f.call('rep', 'POST', '/v1/notifications/read', { all: true }))).toEqual({
      updated: 2,
      unreadCount: 0,
    });
  });

  it('validates', async () => {
    expect((await f.call('rep', 'POST', '/v1/notifications/read', {})).statusCode).toBe(400);
    expect(
      (await f.call('rep', 'POST', '/v1/notifications/read', { ids: ['x'], all: true })).statusCode,
    ).toBe(400);
    expect((await f.call('rep', 'GET', '/v1/notifications?cursor=bad|x')).statusCode).toBe(400);
    expect((await f.call('rep', 'GET', '/v1/notifications?limit=1000')).statusCode).toBe(400);
  });
});
