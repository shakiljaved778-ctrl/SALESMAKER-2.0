import { withTenant } from '@sm/db';
import { FakeStorageProvider } from '@sm/integrations';
import { startHarness, type Harness } from '@sm/records/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { companyFromDomain, leadFromEmail, processInboundEmail } from '../src/index.js';

const T = '01920000-0000-7000-8000-0000000001b2';
let h: Harness;
let rep = '';
let dee = '';
let addressId = '';
const storage = new FakeStorageProvider();
let deps: Parameters<typeof processInboundEmail>[0];

beforeAll(async () => {
  h = await startHarness(T, inject('pgServerAdminUrl'));
  rep = await h.user('rep');
  dee = await h.user('dee');
  await h.grant(rep);
  deps = {
    storage,
    inTenant: (fn) => withTenant(h.prisma, { tenantId: T }, fn, { timeoutMs: 60_000 }),
  };
  await h.inTenant(async ({ prisma: p }) => {
    const rule = await p.assignmentRule.create({
      data: { tenantId: T, object: 'lead', name: 'To dee' },
    });
    await p.assignmentRuleEntry.create({
      data: { tenantId: T, ruleId: rule.id, method: 'SPECIFIC_USER', targetUserId: dee },
    });
    addressId = (
      await p.inboundEmailAddress.create({
        data: {
          tenantId: T,
          name: 'Sales inbox',
          token: 'tok',
          runAsUserId: rep,
          defaults: { lead_source: 'email' },
          assignmentRuleId: rule.id,
        },
      })
    ).id;
  });
});

afterAll(async () => {
  await h.dispose();
});

const mime = (from: string, subject: string, body: string) =>
  Buffer.from(
    [`From: ${from}`, 'To: leads@in.test', `Subject: ${subject}`, '', body, ''].join('\r\n'),
  );

let n = 0;
async function received(raw: Buffer) {
  n += 1;
  const rawKey = `${T}/inbound/${String(n)}`;
  await storage.putObject(rawKey, raw, 'message/rfc822');
  return h.inTenant(({ prisma: p }) =>
    p.inboundEmail.create({
      data: { tenantId: T, addressId, fromAddress: 'x', rawKey },
      select: { id: true },
    }),
  );
}
const row = (id: string) =>
  h.inTenant(({ prisma: p }) => p.inboundEmail.findFirstOrThrow({ where: { id } }));

describe('the lead an email describes', () => {
  it('splits the name, finds the company in business domains, keeps the text', () => {
    expect(companyFromDomain('acme.example')).toBe('Acme');
    expect(companyFromDomain('sales.acme-group.co.uk')).toBe('Acme-group');
    expect(companyFromDomain('gmail.com')).toBeNull();
    expect(companyFromDomain('localhost')).toBeNull();
    expect(
      leadFromEmail({ address: 'mary.ann@acme.example', name: 'Mary Ann Smith' }, 'Hi', 'Body'),
    ).toEqual({
      first_name: 'Mary Ann',
      last_name: 'Smith',
      email: 'mary.ann@acme.example',
      company: 'Acme',
      description: 'Hi\n\nBody',
    });
    expect(leadFromEmail({ address: 'bob@gmail.com', name: null }, null, '')).toEqual({
      last_name: 'bob',
      email: 'bob@gmail.com',
    });
  });
});

describe('processing an inbound email', () => {
  it('creates a lead from a new sender, routed, attributed and scored', async () => {
    const { id } = await received(
      mime('"Omar Haddad" <omar@haddad-trading.example>', 'Quote please', 'Need 40 seats.'),
    );
    await processInboundEmail(deps, id);
    const email = await row(id);
    expect(email).toMatchObject({ status: 'CREATED', recordObject: 'lead', reason: null });
    const lead = await h.inTenant(
      ({ prisma: p }) =>
        p.$queryRaw<Record<string, unknown>[]>`SELECT first_name, last_name, company, owner_id,
        captured_via, lead_source, lead_source_detail, description FROM lead WHERE id = ${email.recordId}::uuid`,
    );
    expect(lead[0]).toEqual({
      first_name: 'Omar',
      last_name: 'Haddad',
      company: 'Haddad-trading',
      owner_id: dee,
      captured_via: 'email',
      lead_source: 'email',
      lead_source_detail: 'Sales inbox',
      description: 'Quote please\n\nNeed 40 seats.',
    });
    // Processed once: a redelivered job does nothing.
    await processInboundEmail(deps, id);
    expect((await row(id)).recordId).toBe(email.recordId);
  });

  it('stores mail from a known sender on their lead instead of creating another', async () => {
    const first = await received(mime('Lina <lina@gmail.com>', 'Hello', 'One'));
    await processInboundEmail(deps, first.id);
    const created = await row(first.id);
    // A freemail sender with no company default: their name stands in.
    const company = await h.inTenant(
      ({ prisma: p }) =>
        p.$queryRaw<
          { company: string }[]
        >`SELECT company FROM lead WHERE id = ${created.recordId}::uuid`,
    );
    expect(company[0]?.company).toBe('Lina');
    const again = await received(mime('LINA@gmail.com', 'Follow-up', 'Two'));
    await processInboundEmail(deps, again.id);
    expect(await row(again.id)).toMatchObject({
      status: 'MATCHED',
      recordObject: 'lead',
      recordId: created.recordId,
    });
  });

  it('refuses mail without a sender', async () => {
    const { id } = await received(Buffer.from('Subject: nobody\r\n\r\nhi\r\n'));
    await processInboundEmail(deps, id);
    expect(await row(id)).toMatchObject({ status: 'REJECTED', reason: 'no_sender' });
  });
});
