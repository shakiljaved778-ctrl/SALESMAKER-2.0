import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setupFixture, type SetupFixture } from './setup-fixture.js';

let f: SetupFixture;
type Json = Record<string, unknown>;
const json = (res: { body: string }) => JSON.parse(res.body) as Json;
const errorsOf = (res: { body: string }) => (json(res)['errors'] as Json[] | undefined) ?? [];
const firstError = (res: { body: string }) => errorsOf(res)[0];

beforeAll(async () => {
  // A small burst so the flood test is quick; every other test uses its own form (own bucket).
  f = await setupFixture('webforms', {}, { FORM_RATE_BURST: 6 });
});

afterAll(async () => {
  await f.api.dispose();
});

const FIELDS = [
  { field: 'first_name' },
  { field: 'last_name', required: true },
  { field: 'company', required: true },
  { field: 'email', required: true, label: 'Work email' },
  { field: 'industry', values: ['banking', 'technology'] },
  { field: 'lead_source', hidden: true, defaultValue: 'advertisement' },
];

async function makeForm(payload: Json = {}) {
  const res = await f.call('admin', 'POST', '/v1/setup/web-forms', {
    name: `Contact ${String(Math.random()).slice(2, 7)}`,
    status: 'ACTIVE',
    runAsUserId: f.id('rep'),
    fields: FIELDS,
    settings: {
      thankYouMessage: 'Thanks!',
      consents: [{ key: 'marketing', text: 'Send me news', required: true }],
    },
    ...payload,
  });
  expect(res.statusCode, res.body).toBe(201);
  return json(res) as Json & { id: string; name: string; version: number };
}

const submit = (formId: string, body: Json, tenant = f.tenantId) =>
  f.api.app.inject({
    method: 'POST',
    url: `/v1/public/forms/${tenant}/${formId}/submissions`,
    payload: body,
    headers: { 'user-agent': 'vitest' },
  });

const visitor = (email: string, extra: Json = {}) => ({
  fields: { first_name: 'Ada', last_name: 'Lovelace', company: 'Engines', email, ...extra },
  consents: { marketing: true },
});

const submissions = (formId: string) =>
  f.inTenant((tx) =>
    tx.prisma.webFormSubmission.findMany({ where: { formId }, orderBy: { id: 'asc' } }),
  );

const leadByEmail = (email: string) =>
  f.inTenant(async (tx) =>
    (
      await tx.prisma.$queryRaw<Json[]>`SELECT id, lead_source, lead_source_detail, captured_via,
        utm_campaign, campaign_id, landing_page, engagement_score FROM lead
        WHERE email = ${email} AND deleted_at IS NULL`
    ).map((r) => r),
  );

describe('Setup → web forms', () => {
  it('creates, reads, changes and deletes a form, audited', async () => {
    const form = await makeForm({
      autoResponder: { subject: 'Hi {first_name}', body: 'Thanks, {first_name}.' },
    });
    expect(form).toMatchObject({
      object: 'lead',
      status: 'ACTIVE',
      runAsUser: { id: f.id('rep') },
      fields: expect.arrayContaining([
        expect.objectContaining({ field: 'email', label: 'Work email', required: true }),
        expect.objectContaining({ field: 'lead_source', hidden: true }),
      ]) as unknown,
      settings: { theme: 'auto', turnstile: false, blockedDomains: [] },
    });
    const got = await f.call('viewer', 'GET', `/v1/setup/web-forms/${form.id}`);
    expect(got.statusCode).toBe(200);
    const changed = await f.call('admin', 'PATCH', `/v1/setup/web-forms/${form.id}`, {
      status: 'INACTIVE',
      autoResponder: null,
      version: form.version,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(json(changed)).toMatchObject({ status: 'INACTIVE', autoResponder: null });
    expect(
      (
        await f.call('admin', 'PATCH', `/v1/setup/web-forms/${form.id}`, {
          name: 'Stale',
          version: form.version,
        })
      ).statusCode,
    ).toBe(409);
    expect((await f.call('admin', 'DELETE', `/v1/setup/web-forms/${form.id}`)).statusCode).toBe(
      204,
    );
    const actions = await f.inTenant((tx) =>
      tx.prisma.setupAudit.findMany({ where: { entityId: form.id }, select: { action: true } }),
    );
    expect(actions.map((a) => a.action).sort()).toEqual([
      'web_form.created',
      'web_form.deleted',
      'web_form.updated',
    ]);
  });

  it('refuses forms whose submissions would fail', async () => {
    const post = (payload: Json) =>
      f.call('admin', 'POST', '/v1/setup/web-forms', {
        name: 'Bad',
        runAsUserId: f.id('rep'),
        fields: FIELDS,
        ...payload,
      });
    const codes = async (payload: Json) => errorsOf(await post(payload)).map((e) => e['code']);
    expect(await codes({ fields: FIELDS.filter((x) => x.field !== 'company') })).toContain(
      'missing_required',
    );
    expect(
      firstError(
        await post({ fields: [...FIELDS.slice(0, 5), { field: 'lead_source', hidden: true }] }),
      ),
    ).toMatchObject({ field: 'fields.5.defaultValue', code: 'required' });
    expect(firstError(await post({ fields: [...FIELDS, { field: 'campaign_id' }] }))).toMatchObject(
      { field: 'fields.6.hidden', code: 'not_supported' },
    );
    expect(
      firstError(
        await post({ fields: [...FIELDS.slice(0, 4), { field: 'industry', values: ['nope'] }] }),
      ),
    ).toMatchObject({ field: 'fields.4.values', code: 'invalid_value' });
    expect(firstError(await post({ fields: [...FIELDS, { field: 'score' }] }))).toMatchObject({
      code: 'not_editable',
    });
    expect(
      firstError(await post({ runAsUserId: '01920000-0000-7000-8000-000000000000' })),
    ).toMatchObject({ field: 'runAsUserId', code: 'invalid_reference' });
    expect(
      firstError(
        await post({
          fields: FIELDS.filter((x) => x.field !== 'email').concat([]),
          defaults: { email: 'x@y.test' },
          autoResponder: { subject: 'Hi', body: 'There' },
        }),
      ),
    ).toMatchObject({ field: 'autoResponder', code: 'needs_email' });
    expect((await post({ fields: [FIELDS[1], FIELDS[1]] })).statusCode).toBe(400);
    expect((await post({ settings: { redirectUrl: 'http://insecure.example' } })).statusCode).toBe(
      400,
    );
  });

  it('is guarded like the rest of Setup', async () => {
    const form = await makeForm();
    await f.expectGuarded('GET', '/v1/setup/web-forms', {});
    await f.expectGuarded('GET', `/v1/setup/web-forms/${form.id}`, {});
    await f.expectGuarded('GET', `/v1/setup/web-forms/${form.id}/submissions`, {});
    await f.expectGuarded('POST', '/v1/setup/web-forms', { payload: { name: 'G' } });
    await f.expectGuarded('PATCH', `/v1/setup/web-forms/${form.id}`, {
      payload: { name: 'G2', version: 1 },
    });
    await f.expectGuarded('DELETE', `/v1/setup/web-forms/${form.id}`, {});
  });
});

describe('the public form', () => {
  it('describes an active form without its hidden fields, in the visitor’s language', async () => {
    const form = await makeForm();
    const res = await f.api.app.inject({
      method: 'GET',
      url: `/v1/public/forms/${f.tenantId}/${form.id}?locale=en`,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = json(res) as { fields: Json[] } & Json;
    expect(body.fields.map((x) => x['name'])).toEqual([
      'first_name',
      'last_name',
      'company',
      'email',
      'industry',
    ]);
    expect(body.fields[3]).toMatchObject({ label: 'Work email', type: 'email', required: true });
    expect((body.fields[4]?.['options'] as Json[]).map((o) => o['value'])).toEqual([
      'banking',
      'technology',
    ]);
    expect(body).toMatchObject({
      consents: [{ key: 'marketing', required: true }],
      turnstileSiteKey: null,
    });
    // Not active, not this tenant's, or no such tenant: all 404.
    const draft = await makeForm({ status: 'DRAFT' });
    for (const url of [
      `/v1/public/forms/${f.tenantId}/${draft.id}`,
      `/v1/public/forms/${f.otherTenant}/${form.id}`,
      `/v1/public/forms/01920000-0000-7000-8000-000000000000/${form.id}`,
    ])
      expect((await f.api.app.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    expect(
      (await f.api.app.inject({ method: 'GET', url: `/v1/public/forms/x/${form.id}` })).statusCode,
    ).toBe(400);
  });

  it('turns a submission into a lead with its source, campaign, score and auto-response', async () => {
    const campaign = await f.call('admin', 'POST', '/v1/records/campaign', {
      fields: { name: 'Spring Launch' },
    });
    expect(campaign.statusCode, campaign.body).toBe(201);
    const model = await f.call('admin', 'POST', '/v1/setup/scoring-models', {
      name: 'Forms',
      isPrimary: true,
      rules: [{ kind: 'ENGAGEMENT', name: 'Form', event: 'form_submission', points: 30 }],
    });
    expect(model.statusCode, model.body).toBe(201);
    const form = await makeForm({
      autoResponder: { subject: 'Hi {first_name}', body: 'Thanks, {first_name}.\nWe will call.' },
    });
    const res = await submit(form.id, {
      ...visitor('ada@forms.test', { industry: 'technology' }),
      context: {
        utmCampaign: 'spring launch',
        utmSource: 'newsletter',
        landingPage: 'https://example.com/landing',
      },
    });
    expect(res.statusCode, res.body).toBe(202);
    expect(json(res)).toEqual({ status: 'received', message: 'Thanks!', redirectUrl: null });

    const [lead] = await leadByEmail('ada@forms.test');
    expect(lead).toMatchObject({
      lead_source: 'advertisement',
      lead_source_detail: form.name,
      captured_via: 'web_form',
      utm_campaign: 'spring launch',
      campaign_id: json(campaign)['id'],
      landing_page: 'https://example.com/landing',
    });
    expect(Number(lead?.['engagement_score'])).toBe(30);
    const [stored] = await submissions(form.id);
    expect(stored).toMatchObject({ status: 'CREATED', recordId: lead?.['id'], reason: null });
    expect(stored?.meta).toMatchObject({ utm_source: 'newsletter', userAgent: 'vitest' });
    expect(JSON.stringify(stored?.meta)).not.toContain('127.0.0.1');

    const mail = f.api.email.lastTo('ada@forms.test');
    expect(mail).toMatchObject({ subject: 'Hi Ada', text: 'Thanks, Ada.\nWe will call.' });
    expect(mail?.html).toBe('<p>Thanks, Ada.<br>We will call.</p>');

    // Setup sees the submission with its attribution, not the IP hash.
    const list = json(
      await f.call('viewer', 'GET', `/v1/setup/web-forms/${form.id}/submissions`),
    ) as { items: Json[] };
    expect(list.items[0]).toMatchObject({ status: 'CREATED', recordId: lead?.['id'] });
    expect(list.items[0]?.['meta']).toEqual({
      utm_source: 'newsletter',
      utm_campaign: 'spring launch',
      landing_page: 'https://example.com/landing',
    });
    await f.inTenant((tx) => tx.prisma.scoringModel.deleteMany({}));
  });

  it('checks values against the form and stores nothing it refuses', async () => {
    const form = await makeForm({
      settings: {
        blockedDomains: ['competitor.test'],
        consents: [{ key: 'marketing', text: 'Send me news', required: true }],
      },
    });
    const refused = async (body: Json) => {
      const res = await submit(form.id, body);
      expect(res.statusCode, res.body).toBe(400);
      return errorsOf(res).map((e) => `${String(e['field'])}:${String(e['code'])}`);
    };
    expect(await refused({ fields: { first_name: 'A' }, consents: {} })).toEqual([
      'fields.last_name:required',
      'fields.company:required',
      'fields.email:required',
      'consents.marketing:required',
    ]);
    expect(await refused(visitor('a@b.test', { lead_source: 'web' }))).toEqual([
      'fields.lead_source:unknown_field',
    ]);
    expect(await refused(visitor('a@b.test', { industry: 'retail' }))).toEqual([
      'fields.industry:invalid_value',
    ]);
    expect(await refused(visitor('not-an-email'))).toEqual(['fields.email:invalid_email']);
    expect(await refused(visitor('x@mailinator.com'))).toEqual(['fields.email:disposable_email']);
    expect(await refused(visitor('x@eu.competitor.test'))).toEqual([
      'fields.email:disposable_email',
    ]);
    expect(await submissions(form.id)).toEqual([]);
  });

  it('answers bots like people but keeps their submissions apart', async () => {
    const form = await makeForm();
    const res = await submit(form.id, { ...visitor('bot@forms.test'), website: 'http://spam' });
    expect(res.statusCode).toBe(202);
    expect(await submissions(form.id)).toEqual([
      expect.objectContaining({ status: 'REJECTED', reason: 'honeypot', recordId: null }),
    ]);
    expect(await leadByEmail('bot@forms.test')).toEqual([]);
  });

  it('asks for a Turnstile token when the form uses it', async () => {
    const form = await makeForm({
      settings: { turnstile: true, consents: [{ key: 'marketing', text: 'News', required: true }] },
    });
    const described = json(
      await f.api.app.inject({ method: 'GET', url: `/v1/public/forms/${f.tenantId}/${form.id}` }),
    );
    expect(described['turnstileSiteKey']).toBe('fake-site-key');
    expect(firstError(await submit(form.id, visitor('t@forms.test')))).toMatchObject({
      field: 'turnstileToken',
      code: 'captcha_failed',
    });
    expect(
      (await submit(form.id, { ...visitor('t@forms.test'), turnstileToken: 'nope' })).statusCode,
    ).toBe(400);
    expect(
      (await submit(form.id, { ...visitor('t@forms.test'), turnstileToken: 'pass' })).statusCode,
    ).toBe(202);
  });

  it('links a submission a Block rule stops to the existing lead', async () => {
    const rule = await f.call('admin', 'POST', '/v1/setup/matching-rules', {
      object: 'lead',
      name: 'Email',
      conditions: [{ field: 'email', method: 'email' }],
    });
    expect(rule.statusCode, rule.body).toBe(201);
    const block = await f.call('admin', 'POST', '/v1/setup/duplicate-rules', {
      object: 'lead',
      name: 'Block same email',
      matchingRuleId: json(rule)['id'],
      action: 'BLOCK',
    });
    expect(block.statusCode, block.body).toBe(201);
    const form = await makeForm();
    expect((await submit(form.id, visitor('dup@forms.test'))).statusCode).toBe(202);
    expect((await submit(form.id, visitor('DUP@forms.test'))).statusCode).toBe(202);
    const leads = await leadByEmail('dup@forms.test');
    expect(leads).toHaveLength(1);
    expect((await submissions(form.id)).map((s) => [s.status, s.recordId])).toEqual([
      ['CREATED', leads[0]?.['id']],
      ['DUPLICATE', leads[0]?.['id']],
    ]);
    await f.inTenant(async (tx) => {
      await tx.prisma.duplicateRule.deleteMany({});
      await tx.prisma.matchingRule.deleteMany({});
    });
  });

  it('limits submissions per network per form', async () => {
    const form = await makeForm();
    const codes: number[] = [];
    for (let i = 0; i < 7; i += 1)
      codes.push(
        (await submit(form.id, { ...visitor('flood@forms.test'), website: 'x' })).statusCode,
      );
    expect(codes).toEqual([202, 202, 202, 202, 202, 202, 429]);
    // Another form has its own bucket.
    const other = await makeForm();
    expect((await submit(other.id, { ...visitor('f@forms.test'), website: 'x' })).statusCode).toBe(
      202,
    );
  });
});
