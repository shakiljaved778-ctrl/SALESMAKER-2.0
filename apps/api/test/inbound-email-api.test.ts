import { withTenant, type TenantTransaction } from '@sm/db';
import { processInboundEmail } from '@sm/imports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  inboundAddress,
  newInboundToken,
  tenantOfToken,
  tokenOfAddress,
} from '../src/capture/inbound-address.js';
import { setupFixture, type SetupFixture } from './setup-fixture.js';

let f: SetupFixture;
type Json = Record<string, unknown>;
const json = (res: { body: string }) => JSON.parse(res.body) as Json;
const firstError = (res: { body: string }) => (json(res)['errors'] as Json[] | undefined)?.[0];
const SECRET = 'inbound-test-secret-0123456789';

beforeAll(async () => {
  f = await setupFixture('inbound', {}, { INBOUND_EMAIL_SECRET: SECRET });
});

afterAll(async () => {
  await f.api.dispose();
});

const create = async (payload: Json = {}) => {
  const res = await f.call('admin', 'POST', '/v1/setup/inbound-addresses', {
    name: `Inbox ${String(Math.random()).slice(2, 7)}`,
    runAsUserId: f.id('rep'),
    defaults: { lead_source: 'email' },
    ...payload,
  });
  expect(res.statusCode, res.body).toBe(201);
  return json(res) as Json & { id: string; address: string; version: number };
};

const mime = (from: string, subject: string, id: string, body = 'Hello there.') =>
  [
    `From: ${from}`,
    'To: someone@in.test',
    `Subject: ${subject}`,
    `Message-ID: <${id}@mail.test>`,
    '',
    body,
    '',
  ].join('\r\n');

const deliver = (recipients: string[], raw: string, secret = SECRET) =>
  f.api.app.inject({
    method: 'POST',
    url: '/v1/inbound/email',
    headers: { 'x-sm-inbound-secret': secret },
    payload: { recipients, raw: Buffer.from(raw).toString('base64') },
  });

const processEmail = (emailId: string) =>
  processInboundEmail(
    {
      storage: f.api.storage,
      inTenant: <T>(fn: (tx: TenantTransaction) => Promise<T>) =>
        withTenant(f.prisma, { tenantId: f.tenantId }, fn, { timeoutMs: 60_000 }),
    },
    emailId,
  );

describe('inbound address tokens', () => {
  it('carry the tenant, and only our domain’s addresses yield one', () => {
    const tenant = '01920000-0000-7000-8000-00000000abcd';
    const token = newInboundToken(tenant);
    expect(token).toMatch(/^[a-z2-7]{42}$/);
    expect(tenantOfToken(token)).toBe(tenant);
    expect(newInboundToken(tenant)).not.toBe(token);
    const address = inboundAddress(token, 'in.salesmaker.test');
    expect(tokenOfAddress(address.toUpperCase(), 'in.salesmaker.test')).toBe(token);
    expect(tokenOfAddress(address, 'in.other.test')).toBeNull();
    expect(tokenOfAddress(`sales-${token}@in.salesmaker.test`, 'in.salesmaker.test')).toBeNull();
    expect(tenantOfToken('short')).toBeNull();
  });
});

describe('Setup → email-to-lead', () => {
  it('creates, reads, changes, rotates and deletes addresses, audited', async () => {
    const a = await create({ name: 'Sales inbox' });
    expect(a).toMatchObject({
      status: 'ACTIVE',
      runAsUser: { id: f.id('rep') },
      defaults: { lead_source: 'email' },
    });
    expect(a.address).toMatch(/^leads-[a-z2-7]{42}@in\.salesmaker\.localhost$/);
    expect(json(await f.call('viewer', 'GET', `/v1/setup/inbound-addresses/${a.id}`))).toEqual(a);
    const rotated = await f.call('admin', 'PATCH', `/v1/setup/inbound-addresses/${a.id}`, {
      rotateAddress: true,
      version: a.version,
    });
    expect(rotated.statusCode, rotated.body).toBe(200);
    expect(json(rotated)['address']).not.toBe(a.address);
    expect(
      (
        await f.call('admin', 'PATCH', `/v1/setup/inbound-addresses/${a.id}`, {
          name: 'Stale',
          version: a.version,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await f.call('admin', 'DELETE', `/v1/setup/inbound-addresses/${a.id}`)).statusCode,
    ).toBe(204);
    const actions = await f.inTenant((tx) =>
      tx.prisma.setupAudit.findMany({ where: { entityId: a.id }, select: { action: true } }),
    );
    expect(actions.map((x) => x.action).sort()).toEqual([
      'inbound_address.created',
      'inbound_address.deleted',
      'inbound_address.rotated',
    ]);
  });

  it('refuses addresses whose leads would fail', async () => {
    const post = (payload: Json) =>
      f.call('admin', 'POST', '/v1/setup/inbound-addresses', {
        name: 'Bad',
        runAsUserId: f.id('rep'),
        ...payload,
      });
    expect(firstError(await post({ runAsUserId: f.id('outsider') }))).toMatchObject({
      field: 'runAsUserId',
      code: 'invalid_reference',
    });
    expect(firstError(await post({ defaults: { score: 5 } }))).toMatchObject({
      field: 'defaults.score',
      code: 'not_editable',
    });
    expect(
      firstError(await post({ assignmentRuleId: '01920000-0000-7000-8000-000000000000' })),
    ).toMatchObject({ field: 'assignmentRuleId', code: 'invalid_reference' });
  });

  it('is guarded like the rest of Setup', async () => {
    const a = await create();
    await f.expectGuarded('GET', '/v1/setup/inbound-addresses', {});
    await f.expectGuarded('GET', `/v1/setup/inbound-addresses/${a.id}`, {});
    await f.expectGuarded('GET', `/v1/setup/inbound-addresses/${a.id}/emails`, {});
    await f.expectGuarded('POST', '/v1/setup/inbound-addresses', { payload: { name: 'G' } });
    await f.expectGuarded('PATCH', `/v1/setup/inbound-addresses/${a.id}`, {
      payload: { name: 'G2', version: 1 },
    });
    await f.expectGuarded('DELETE', `/v1/setup/inbound-addresses/${a.id}`, {});
  });
});

describe('delivery and the record’s emails', () => {
  it('stores mail for active addresses once, then files it as a lead', async () => {
    const a = await create({ name: 'Leads inbox' });
    const raw = mime('"Nadia Karim" <nadia@karim-logistics.example>', 'Fleet quote', 'm1');
    expect((await deliver([a.address], raw, 'wrong-secret-value-0123456')).statusCode).toBe(401);
    expect(
      (await f.api.app.inject({ method: 'POST', url: '/v1/inbound/email', payload: {} }))
        .statusCode,
    ).toBe(401);

    const res = await deliver([a.address.toUpperCase(), 'someone@else.test'], raw);
    expect(res.statusCode, res.body).toBe(202);
    expect(json(res)).toEqual({ accepted: 1 });
    // The same Message-ID again: already stored.
    expect(json(await deliver([a.address], raw))).toEqual({ accepted: 0 });

    const [email] = await f.inTenant((tx) =>
      tx.prisma.inboundEmail.findMany({ where: { addressId: a.id } }),
    );
    expect(email).toMatchObject({
      status: 'RECEIVED',
      fromAddress: 'nadia@karim-logistics.example',
      fromName: 'Nadia Karim',
      subject: 'Fleet quote',
      messageId: '<m1@mail.test>',
    });
    expect(f.api.storage.objects.get(email?.rawKey ?? '')?.body?.toString()).toBe(raw);
    expect(
      await f.inTenant((tx) =>
        tx.prisma.outboxEvent.count({
          where: { topic: 'email-sync.inbound_lead', aggregateId: email?.id ?? '' },
        }),
      ),
    ).toBe(1);

    await processEmail(email?.id ?? '');
    const done = await f.inTenant((tx) =>
      tx.prisma.inboundEmail.findFirstOrThrow({ where: { id: email?.id ?? '' } }),
    );
    expect(done).toMatchObject({ status: 'CREATED', recordObject: 'lead' });
    const leadId = done.recordId ?? '';

    // On the lead: listed for whoever can see it, with its text.
    const list = await f.call('rep', 'GET', `/v1/records/lead/${leadId}/inbound-emails`);
    expect(list.statusCode, list.body).toBe(200);
    expect(json(list)['items']).toEqual([
      expect.objectContaining({ id: done.id, subject: 'Fleet quote', status: 'CREATED' }),
    ]);
    const one = await f.call('rep', 'GET', `/v1/records/lead/${leadId}/inbound-emails/${done.id}`);
    expect(json(one)).toMatchObject({ subject: 'Fleet quote', text: 'Hello there.' });
    expect(
      (await f.call('peer', 'GET', `/v1/records/lead/${leadId}/inbound-emails`)).statusCode,
    ).toBe(404);
    expect(
      (await f.call('outsider', 'GET', `/v1/records/lead/${leadId}/inbound-emails`)).statusCode,
    ).toBe(404);
    expect(
      (await f.call('rep', 'GET', `/v1/records/opportunity/${leadId}/inbound-emails`)).statusCode,
    ).toBe(400);
    expect(
      (await f.call('rep', 'GET', `/v1/records/lead/${leadId}/inbound-emails/${a.id}`)).statusCode,
    ).toBe(404);

    // Setup sees it at its address.
    const emails = json(
      await f.call('viewer', 'GET', `/v1/setup/inbound-addresses/${a.id}/emails`),
    );
    expect(emails['items']).toEqual([
      expect.objectContaining({ status: 'CREATED', recordId: leadId }),
    ]);
  });

  it('drops mail for inactive, rotated or unknown addresses', async () => {
    const a = await create();
    const off = await f.call('admin', 'PATCH', `/v1/setup/inbound-addresses/${a.id}`, {
      status: 'INACTIVE',
      version: a.version,
    });
    expect(json(await deliver([a.address], mime('x@y.example', 'Hi', 'm2')))).toEqual({
      accepted: 0,
    });
    const rotated = await f.call('admin', 'PATCH', `/v1/setup/inbound-addresses/${a.id}`, {
      status: 'ACTIVE',
      rotateAddress: true,
      version: json(off)['version'],
    });
    expect(json(await deliver([a.address], mime('x@y.example', 'Hi', 'm3')))).toEqual({
      accepted: 0,
    });
    expect(
      json(await deliver([String(json(rotated)['address'])], mime('x@y.example', 'Hi', 'm4'))),
    ).toEqual({ accepted: 1 });
    const stranger = inboundAddress(newInboundToken(f.otherTenant), 'in.salesmaker.localhost');
    expect(json(await deliver([stranger], mime('x@y.example', 'Hi', 'm5')))).toEqual({
      accepted: 0,
    });
  });
});
