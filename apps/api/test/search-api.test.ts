import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupFixture, type SetupFixture } from './setup-fixture.js';

let f: SetupFixture;
type Json = Record<string, unknown>;
const json = (res: { body: string }) => JSON.parse(res.body) as Json;
const groups = (res: { body: string }) =>
  json(res)['groups'] as { object: string; hits: Json[]; total?: number }[];
let lead = '';

beforeAll(async () => {
  f = await setupFixture('search');
  lead = String(
    json(
      await f.call('rep', 'POST', '/v1/records/lead', {
        fields: {
          first_name: 'Maya',
          last_name: 'Chen',
          company: 'Pixelcraft',
          email: 'maya@pixelcraft.example',
          phone: '+44 20 7946 0958',
        },
      }),
    )['id'],
  );
  await f.call('peer', 'POST', '/v1/records/lead', {
    fields: { last_name: 'Hidden', company: 'Pixelcraft' },
  });
});

afterAll(async () => {
  await f.api.dispose();
});

describe('GET /v1/search (§7.19)', () => {
  it('finds visible records by name, email, typo and phone suffix', async () => {
    const res = await f.call('rep', 'GET', '/v1/search?q=pixelcraft&objects=lead&totals=true');
    expect(res.statusCode).toBe(200);
    expect(groups(res)).toEqual([
      {
        object: 'lead',
        total: 1,
        hits: [
          expect.objectContaining({
            id: lead,
            name: 'Maya Chen',
            matched: ['email', 'company'],
            record: expect.objectContaining({ id: lead, last_name: 'Chen' }) as unknown,
          }),
        ],
      },
    ]);
    const first = async (q: string) =>
      groups(await f.call('rep', 'GET', `/v1/search?q=${encodeURIComponent(q)}&objects=lead`))[0]
        ?.hits[0]?.['name'];
    expect(await first('maya@pixelcraft')).toBe('Maya Chen');
    expect(await first('Chne Maya')).toBe('Maya Chen');
    expect(await first('7946 0958')).toBe('Maya Chen');
    // Every object the caller can read is searched by default.
    const all = groups(await f.call('rep', 'GET', '/v1/search?q=maya'));
    expect(all.map((g) => g.object).sort()).toEqual([
      'account',
      'campaign',
      'contact',
      'lead',
      'opportunity',
    ]);
  });

  it('validates input and shows nothing of other people or workspaces', async () => {
    expect((await f.call('rep', 'GET', '/v1/search')).statusCode).toBe(400);
    expect((await f.call('rep', 'GET', '/v1/search?q=x&limit=500')).statusCode).toBe(400);
    expect((await f.call('rep', 'GET', '/v1/search?q=x&ownerId=nope')).statusCode).toBe(400);
    const peer = groups(await f.call('peer', 'GET', '/v1/search?q=pixelcraft&objects=lead'));
    expect(peer[0]?.hits.map((h) => h['name'])).toEqual(['Hidden']);
    const outsider = groups(
      await f.call('outsider', 'GET', '/v1/search?q=pixelcraft&objects=lead'),
    );
    expect(outsider[0]?.hits).toEqual([]);
    expect((await f.api.app.inject({ method: 'GET', url: '/v1/search?q=x' })).statusCode).toBe(401);
  });

  it('does not search hidden fields', async () => {
    await f.inTenant(async ({ prisma }) => {
      const profile = await prisma.profile.findFirstOrThrow({
        where: { id: f.id('profile:standard') },
      });
      await prisma.fieldPermission.updateMany({
        where: {
          permissionSetId: profile.permissionSetId,
          object: 'lead',
          field: { in: ['email', 'phone'] },
        },
        data: { canRead: false, canEdit: false },
      });
      await prisma.tenantSettings.update({
        where: { tenantId: f.tenantId },
        data: { permVersion: { increment: 1 } },
      });
    });
    for (const q of ['maya@pixelcraft.example', '7946 0958'])
      expect(
        groups(await f.call('rep', 'GET', `/v1/search?q=${encodeURIComponent(q)}&objects=lead`))[0]
          ?.hits,
      ).toEqual([]);
  });
});

describe('recent items', () => {
  it('records views of visible records and lists them', async () => {
    expect((await f.call('rep', 'POST', `/v1/records/lead/${lead}/viewed`)).statusCode).toBe(204);
    expect((await f.call('peer', 'POST', `/v1/records/lead/${lead}/viewed`)).statusCode).toBe(404);
    expect((await f.call('outsider', 'POST', `/v1/records/lead/${lead}/viewed`)).statusCode).toBe(
      404,
    );
    const res = await f.call('rep', 'GET', '/v1/recent-items');
    expect(res.statusCode).toBe(200);
    expect(json(res)['items']).toEqual([
      expect.objectContaining({ object: 'lead', id: lead, name: 'Maya Chen' }),
    ]);
    expect(json(await f.call('peer', 'GET', '/v1/recent-items'))['items']).toEqual([]);
  });
});
