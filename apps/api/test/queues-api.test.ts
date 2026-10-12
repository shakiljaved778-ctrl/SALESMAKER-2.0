import { visibility } from '@sm/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupFixture, type SetupFixture } from './setup-fixture.js';

let f: SetupFixture;
type Json = Record<string, unknown>;
const json = (res: { body: string }) => JSON.parse(res.body) as Json;
let queue = '';

beforeAll(async () => {
  f = await setupFixture('queues');
  queue = await f.inTenant(async ({ prisma: p }) => {
    const q = await p.queue.create({ data: { tenantId: f.tenantId, name: 'Inbound' } });
    await p.queueObject.create({ data: { tenantId: f.tenantId, queueId: q.id, object: 'lead' } });
    await p.queueMember.createMany({
      data: ['rep', 'viewer'].map((u) => ({
        tenantId: f.tenantId,
        queueId: q.id,
        memberType: 'USER' as const,
        userId: f.id(u),
      })),
    });
    return q.id;
  });
  // What Setup does after a membership change: members see what the queue owns.
  await f.inTenant(async (tx) => {
    await visibility.rebuild(tx);
  });
});

afterAll(async () => {
  await f.api.dispose();
});

async function queued(count: number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const res = await f.call('admin', 'POST', '/v1/records/lead', {
      fields: { last_name: `Q${String(i)}`, company: 'Queue', owner_id: queue },
    });
    expect(res.statusCode, res.body).toBe(201);
    ids.push(json(res)['id'] as string);
  }
  return ids;
}
const takeNext = (user: string) =>
  f.call(user, 'POST', `/v1/queues/${queue}/take-next`, { object: 'lead' });

describe('queue pick-up (§7.3)', () => {
  it('lists my queues and takes the oldest record first, one at a time, until empty', async () => {
    const ids = await queued(2);
    const mine = await f.call('rep', 'GET', '/v1/queues/mine');
    expect(json(mine)['items']).toEqual([
      { id: queue, name: 'Inbound', objects: ['lead'], waiting: { lead: 2 } },
    ]);
    const first = await takeNext('rep');
    expect(first.statusCode, first.body).toBe(200);
    expect(json(first)).toEqual({ id: ids[0], object: 'lead' });
    const owner = await f.call('rep', 'GET', `/v1/records/lead/${ids[0] ?? ''}`);
    expect(json(owner)['owner_id']).toMatchObject({ id: f.id('rep') });
    expect(json(await takeNext('rep'))).toEqual({ id: ids[1], object: 'lead' });
    expect(json(await takeNext('rep'))).toEqual({ id: null, object: 'lead' });
    const log = await f.inTenant((tx) =>
      tx.prisma.assignmentLog.findFirstOrThrow({ where: { recordId: ids[0] ?? '' } }),
    );
    expect(log).toMatchObject({
      source: 'take_next',
      ownerId: f.id('rep'),
      previousOwnerId: queue,
    });
  });

  it('never gives the same record to two members taking at once', async () => {
    await queued(2);
    const [a, b] = await Promise.all([takeNext('rep'), takeNext('viewer')]);
    const taken = [json(a)['id'], json(b)['id']];
    expect(taken.every(Boolean)).toBe(true);
    expect(new Set(taken).size).toBe(2);
  });

  it('accepts a record the queue still owns, once', async () => {
    const [id] = await queued(1);
    const seen = await f.call('rep', 'GET', `/v1/records/lead/${id ?? ''}`);
    expect(seen.statusCode, seen.body).toBe(200);
    const res = await f.call('rep', 'POST', `/v1/records/lead/${id ?? ''}/accept`);
    expect(res.statusCode, res.body).toBe(200);
    expect(json(res)).toEqual({ id, object: 'lead' });
    const again = await f.call('rep', 'POST', `/v1/records/lead/${id ?? ''}/accept`);
    expect(again.statusCode).toBe(409);
  });

  it('is for members only, validates and keeps other workspaces out', async () => {
    const [id] = await queued(1);
    expect((await takeNext('peer')).statusCode).toBe(403);
    expect((await f.call('peer', 'POST', `/v1/records/lead/${id ?? ''}/accept`)).statusCode).toBe(
      404,
    );
    expect(
      (await f.call('rep', 'POST', `/v1/queues/${queue}/take-next`, { object: 'campaign' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await f.call('rep', 'POST', `/v1/queues/${queue}/take-next`, { object: 'contact' }))
        .statusCode,
    ).toBe(404);
    expect(
      (await f.call('outsider', 'POST', `/v1/queues/${queue}/take-next`, { object: 'lead' }))
        .statusCode,
    ).toBe(404);
    expect(
      (await f.call('outsider', 'POST', `/v1/records/lead/${id ?? ''}/accept`)).statusCode,
    ).toBe(404);
    expect(json(await f.call('outsider', 'GET', '/v1/queues/mine'))['items']).toEqual([]);
  });
});
