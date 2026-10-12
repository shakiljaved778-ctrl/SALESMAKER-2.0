import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { captureLead, captureValues, readStored, type CaptureInput } from '../src/index.js';
import { startHarness, type Harness } from './support.js';

const T = '01920000-0000-7000-8000-000000000c0a';
let h: Harness;
let rep = '';
let form = '';

beforeAll(async () => {
  h = await startHarness(T);
  rep = await h.user('rep');
  await h.grant(rep);
  await h.inTenant(async ({ prisma: p }) => {
    const model = await p.scoringModel.create({
      data: { tenantId: T, name: 'Forms', isPrimary: true, fitWeight: 0 },
    });
    await p.scoringRule.create({
      data: {
        tenantId: T,
        modelId: model.id,
        kind: 'ENGAGEMENT',
        name: 'Form',
        event: 'form_submission',
        points: 40,
      },
    });
    form = (await p.webForm.create({ data: { tenantId: T, name: 'Contact', runAsUserId: rep } }))
      .id;
  });
});

afterAll(async () => {
  await h.dispose();
});

const input = (
  fields: Record<string, unknown>,
  extra: Partial<CaptureInput> = {},
): CaptureInput => ({
  runAsUserId: rep,
  fields,
  defaults: { lead_source: 'event', industry: 'banking' },
  source: { capturedVia: 'web_form', detail: 'Contact', utm: { source: 'ads' }, gclid: 'g1' },
  assignmentRuleId: null,
  ...extra,
});

describe('the capture pipeline', () => {
  it('fills defaults only where the input is empty and always stamps the source', () => {
    expect(
      captureValues(input({ last_name: 'L', industry: '', lead_source: 'web', captured_via: 'x' })),
    ).toEqual({
      last_name: 'L',
      lead_source: 'web',
      industry: 'banking',
      lead_source_detail: 'Contact',
      captured_via: 'web_form',
      utm_source: 'ads',
      gclid: 'g1',
    });
    const long = 'x'.repeat(300);
    expect(
      captureValues(input({}, { source: { capturedVia: 'email', detail: long } })),
    ).toMatchObject({ lead_source: 'event', lead_source_detail: 'x'.repeat(255) });
    expect(
      captureValues({ ...input({}), defaults: {}, source: { capturedVia: 'email', detail: 'In' } }),
    ).toMatchObject({ lead_source: 'email', captured_via: 'email' });
  });

  it('creates the lead, records the event, then rescores it', async () => {
    const out = await h.inTenant((tx) =>
      captureLead(tx, input({ last_name: 'Kay', company: 'K' }), async (r) => {
        await tx.prisma.webFormSubmission.create({
          data: { tenantId: T, formId: form, payload: {}, status: r.status, recordId: r.recordId },
        });
      }),
    );
    expect(out).toMatchObject({ status: 'CREATED', errors: [] });
    const lead = await h.inTenant(async (tx) => {
      const object = (await h.context(tx, rep)).metadata.object('lead');
      return object ? readStored(tx, object, out.recordId ?? '') : null;
    });
    expect(lead?.values).toMatchObject({
      captured_via: 'web_form',
      lead_source: 'event',
      engagement_score: '40',
      owner_id: rep,
    });
  });

  it('drops attribution its field will not take instead of refusing the lead', async () => {
    const out = await h.inTenant((tx) =>
      captureLead(
        tx,
        input(
          { last_name: 'Local', company: 'L' },
          {
            source: {
              capturedVia: 'web_form',
              detail: 'Contact',
              landingPage: 'http://localhost:3000/f/x',
              referrer: 'https://partner.example/page',
            },
          },
        ),
      ),
    );
    expect(out.status).toBe('CREATED');
    const lead = await h.inTenant(async (tx) => {
      const object = (await h.context(tx, rep)).metadata.object('lead');
      return object ? readStored(tx, object, out.recordId ?? '') : null;
    });
    expect(lead?.values).toMatchObject({
      landing_page: null,
      referrer: 'https://partner.example/page',
    });
  });

  it('reports refusals without losing the caller’s transaction', async () => {
    const result = await h.inTenant(async (tx) => {
      const r = await captureLead(tx, input({ company: 'No surname' }));
      // The transaction still works after the savepoint was rolled back.
      await tx.prisma.webFormSubmission.create({
        data: { tenantId: T, formId: form, payload: {}, status: r.status },
      });
      return r;
    });
    expect(result).toEqual({
      status: 'FAILED',
      recordId: null,
      errors: [{ field: 'last_name', code: 'required' }],
    });
    expect(
      await h.inTenant(({ prisma: p }) =>
        p.webFormSubmission.count({ where: { status: 'FAILED' } }),
      ),
    ).toBe(1);
  });
});
