import type { TenantTransaction } from '@sm/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  checkMappings,
  convertLead,
  createRecord,
  effectiveMappings,
  readStored,
  RecordError,
  saveMappings,
  undoConversion,
  updateRecord,
  type ConvertInput,
  type RecordContext,
} from '../src/index.js';
import { allFields, startHarness, type Harness } from './support.js';

const T = '01920000-0000-7000-8000-000000000d07';
let h: Harness;
const users: Record<string, string> = {};
const u = (name: string) => users[name] ?? '';

beforeAll(async () => {
  h = await startHarness(T);
  await h.unit('sales');
  await h.unit('emea', 'sales');
  users['boss'] = await h.user('boss', 'sales');
  users['rep'] = await h.user('rep', 'emea');
  users['peer'] = await h.user('peer', 'emea');
});

afterAll(async () => {
  await h.dispose();
});

type Grants = Parameters<Harness['context']>[2];
const as = <T>(
  user: string,
  fn: (tx: TenantTransaction, ctx: RecordContext) => Promise<T>,
  grants?: Grants,
  now?: Date,
) =>
  h.inTenant(async (tx) => {
    const ctx = await h.context(tx, u(user), grants);
    return fn(tx, now ? { ...ctx, now: () => now } : ctx);
  });
const create = (user: string, object: string, fields: Record<string, unknown>) =>
  as(user, async (tx, ctx) => (await createRecord(tx, ctx, object, { fields })).id);
const stored = (object: string, id: string) =>
  as('boss', (tx, ctx) => {
    const meta = ctx.metadata.object(object);
    if (!meta) throw new Error(object);
    return readStored(tx, meta, id, { includeDeleted: true });
  });
const convert = (user: string, lead: string, input: ConvertInput, grants?: Grants) =>
  as(user, (tx, ctx) => convertLead(tx, ctx, lead, input), grants);
async function refused(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    if (err instanceof RecordError)
      return `${String(err.status)} ${err.errors.map((e) => `${e.field}:${e.code}`).join()}`;
    throw err;
  }
  return 'accepted';
}
const newLead = (extra: Record<string, unknown> = {}) =>
  create('rep', 'lead', {
    first_name: 'Maya',
    last_name: 'Chen',
    company: 'Pixelcraft',
    email: 'maya@pixelcraft.example',
    title: 'CTO',
    lead_source: 'web',
    city: 'Lisbon',
    annual_revenue: '1000',
    ...extra,
  });

describe('convertLead (§7.3)', () => {
  it('creates the account, contact and opportunity from the mapping and locks the lead', async () => {
    const lead = await newLead();
    const campaign = await create('rep', 'campaign', { name: 'Spring' });
    await h.inTenant(({ prisma }) =>
      prisma.campaignMember.create({ data: { tenantId: T, campaignId: campaign, leadId: lead } }),
    );
    const result = await convert('rep', lead, {
      account: {},
      contact: {},
      opportunity: { fields: { close_date: '2026-12-31' } },
    });
    const account = await stored('account', result.accountId);
    expect(account?.values).toMatchObject({
      name: 'Pixelcraft',
      billing_city: 'Lisbon',
      annual_revenue: '1000.00',
      owner_id: u('rep'),
    });
    const contact = await stored('contact', result.contactId);
    expect(contact?.values).toMatchObject({
      first_name: 'Maya',
      last_name: 'Chen',
      email: 'maya@pixelcraft.example',
      title: 'CTO',
      mailing_city: 'Lisbon',
      account_id: result.accountId,
    });
    expect(result.opportunityId).not.toBeNull();
    const opp = await stored('opportunity', result.opportunityId ?? '');
    expect(opp?.values).toMatchObject({
      name: 'Pixelcraft',
      account_id: result.accountId,
      primary_contact_id: result.contactId,
      stage: 'qualification',
    });
    const leadAfter = await stored('lead', lead);
    expect(leadAfter?.values).toMatchObject({
      status: 'converted',
      converted_account_id: result.accountId,
      converted_contact_id: result.contactId,
      converted_opportunity_id: result.opportunityId,
    });
    expect(leadAfter?.values['converted_at']).toMatch(/^\d{4}-/);
    await h.inTenant(async ({ prisma }) => {
      expect(await prisma.opportunityContactRole.findMany()).toEqual([
        expect.objectContaining({ contactId: result.contactId, isPrimary: true }),
      ]);
      expect(
        (await prisma.campaignMember.findMany({ where: { campaignId: campaign } }))
          .map((m) => (m.leadId ? 'lead' : m.contactId === result.contactId ? 'contact' : 'other'))
          .sort(),
      ).toEqual(['contact', 'lead']);
      expect(await prisma.auditLog.count({ where: { action: 'lead.converted' } })).toBe(1);
    });
    // Converted leads are read-only and convert once.
    expect(
      await refused(
        as('rep', (tx, ctx) =>
          updateRecord(tx, ctx, 'lead', lead, { fields: { title: 'X' } }, null),
        ),
      ),
    ).toBe('409 _record:record_locked');
    expect(await refused(convert('rep', lead, { account: {}, contact: {} }))).toBe(
      '409 _record:already_converted',
    );
  });

  it('converts into an existing account and contact the caller can see', async () => {
    const account = await create('rep', 'account', { name: 'Existing Co' });
    const loose = await create('rep', 'contact', { last_name: 'Loose' });
    const lead = await newLead({ company: 'Existing Co' });
    const result = await convert('rep', lead, { account: { id: account }, contact: { id: loose } });
    expect(result).toMatchObject({ accountId: account, contactId: loose, opportunityId: null });
    expect((await stored('contact', loose))?.values['account_id']).toBe(account);

    const other = await create('rep', 'account', { name: 'Other Co' });
    const theirs = await create('rep', 'contact', { last_name: 'Bound', account_id: other });
    const invisible = await create('peer', 'account', { name: 'Hidden Co' });
    expect(
      await refused(
        convert('rep', await newLead(), { account: { id: account }, contact: { id: theirs } }),
      ),
    ).toBe('400 contact.id:contact_of_other_account');
    expect(
      await refused(convert('rep', await newLead(), { account: { id: invisible }, contact: {} })),
    ).toBe('400 account.id:invalid_reference');
    expect(
      await refused(
        convert('rep', await newLead(), { account: {}, contact: {}, convertedStatus: 'open' }),
      ),
    ).toBe('400 convertedStatus:not_a_converted_status');
    // Someone who cannot see the lead cannot convert it.
    expect(await refused(convert('peer', await newLead(), { account: {}, contact: {} }))).toBe(
      '404 ',
    );
  });

  it('copies only what the caller may read on the lead and edit on the target', async () => {
    const lead = await newLead();
    const result = await convert(
      'rep',
      lead,
      { account: {}, contact: {} },
      { fields: allFields({ contact: ['email'] }) },
    );
    expect((await stored('contact', result.contactId))?.values['email']).toBeNull();
  });
});

describe('undoConversion', () => {
  it('removes what conversion created and restores the lead, within 24 hours', async () => {
    const lead = await newLead();
    const result = await convert('rep', lead, {
      account: {},
      contact: {},
      opportunity: { fields: { close_date: '2026-12-31' } },
    });
    await as('rep', (tx, ctx) => undoConversion(tx, ctx, lead));
    for (const [object, id] of [
      ['account', result.accountId],
      ['contact', result.contactId],
      ['opportunity', result.opportunityId ?? ''],
    ] as const)
      expect(await stored(object, id)).toBeNull();
    expect((await stored('lead', lead))?.values).toMatchObject({
      status: 'open',
      converted_at: null,
      converted_account_id: null,
    });
    // It can be converted again, and undone again.
    await convert('rep', lead, { account: {}, contact: {} });
    await as('rep', (tx, ctx) => undoConversion(tx, ctx, lead));
    expect(await refused(as('rep', (tx, ctx) => undoConversion(tx, ctx, lead)))).toBe('404 ');
  });

  it('gives a contact that joined the account back its independence', async () => {
    const account = await create('rep', 'account', { name: 'Kept Co' });
    const loose = await create('rep', 'contact', { last_name: 'Loose' });
    const lead = await newLead();
    const campaign = await create('rep', 'campaign', { name: 'Autumn' });
    await h.inTenant(({ prisma }) =>
      prisma.campaignMember.create({ data: { tenantId: T, campaignId: campaign, leadId: lead } }),
    );
    await convert('rep', lead, { account: { id: account }, contact: { id: loose } });
    const members = () =>
      h.inTenant(({ prisma }) => prisma.campaignMember.count({ where: { contactId: loose } }));
    expect(await members()).toBe(1);
    await as('rep', (tx, ctx) => undoConversion(tx, ctx, lead));
    expect(await members()).toBe(0);
    expect((await stored('contact', loose))?.values['account_id']).toBeNull();
    expect(await stored('account', account)).not.toBeNull();
  });

  it('refuses once anything changed, after 24 hours, or for someone else', async () => {
    const lead = await newLead();
    const result = await convert('rep', lead, { account: {}, contact: {} });
    expect(await refused(as('peer', (tx, ctx) => undoConversion(tx, ctx, lead)))).toBe('404 ');
    // The boss sees the lead (hierarchy) but did not convert it.
    expect(await refused(as('boss', (tx, ctx) => undoConversion(tx, ctx, lead)))).toBe(
      '403 _record:not_your_conversion',
    );
    const later = new Date(Date.now() + 25 * 3_600_000);
    expect(
      await refused(as('rep', (tx, ctx) => undoConversion(tx, ctx, lead), undefined, later)),
    ).toBe('409 _record:undo_window_passed');
    await as('rep', (tx, ctx) =>
      updateRecord(
        tx,
        ctx,
        'account',
        result.accountId,
        { fields: { phone: '+351 21 000 0000' } },
        null,
      ),
    );
    expect(await refused(as('rep', (tx, ctx) => undoConversion(tx, ctx, lead)))).toBe(
      '409 account:changed_since_conversion',
    );
    // An administrator may undo anyone's conversion (here: still blocked by the change).
    expect(
      await refused(
        as('boss', (tx, ctx) => undoConversion(tx, ctx, lead), { system: ['modify_all_data'] }),
      ),
    ).toBe('409 account:changed_since_conversion');
  });
});

describe('field mapping', () => {
  it('checks types and targets, and admin mappings override the defaults', async () => {
    await h.inTenant(async (tx) => {
      const { metadata } = await h.context(tx, u('boss'));
      expect(
        checkMappings(metadata, [
          { leadField: 'email', targetObject: 'account', targetField: 'number_of_employees' },
          { leadField: 'nope', targetObject: 'account', targetField: 'name' },
          { leadField: 'title', targetObject: 'account', targetField: 'nope' },
          { leadField: 'title', targetObject: 'account', targetField: 'owner_id' },
          { leadField: 'title', targetObject: 'account', targetField: 'description' },
          { leadField: 'company', targetObject: 'account', targetField: 'description' },
          { leadField: 'campaign_id', targetObject: 'opportunity', targetField: 'account_id' },
          { leadField: 'annual_revenue', targetObject: 'opportunity', targetField: 'amount' },
        ]).map((e) => `${e.field}:${e.code}`),
      ).toEqual([
        'mappings.0:incompatible_types',
        'mappings.1:unknown_lead_field',
        'mappings.2:unknown_target_field',
        'mappings.3:unknown_target_field',
        'mappings.5:duplicate_target',
        'mappings.6:incompatible_types',
      ]);
      await expect(
        saveMappings(tx, metadata, [
          { leadField: 'email', targetObject: 'account', targetField: 'number_of_employees' },
        ]),
      ).rejects.toThrow(RecordError);
      await saveMappings(tx, metadata, [
        { leadField: 'title', targetObject: 'account', targetField: 'description' },
        { leadField: 'email', targetObject: 'contact', targetField: 'description' },
      ]);
      const effective = await effectiveMappings(tx);
      expect(effective).toContainEqual({
        leadField: 'email',
        targetObject: 'contact',
        targetField: 'description',
      });
      expect(
        effective.filter((m) => m.targetObject === 'contact' && m.targetField === 'description'),
      ).toHaveLength(1);
    });
    const lead = await newLead();
    const result = await convert('rep', lead, { account: {}, contact: {} });
    expect((await stored('account', result.accountId))?.values['description']).toBe('CTO');
    expect((await stored('contact', result.contactId))?.values['description']).toBe(
      'maya@pixelcraft.example',
    );
  });
});
