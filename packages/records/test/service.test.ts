import type { TenantTransaction } from '@sm/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRecord,
  readStored,
  RecordError,
  updateRecord,
  type WriteInput,
} from '../src/index.js';
import { allFields, FULL, startHarness, type Harness } from './support.js';

const T = '01920000-0000-7000-8000-000000000d01';
let h: Harness;
const users: Record<string, string> = {};

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
const create = (user: string, object: string, input: WriteInput, grants?: Grants) =>
  h.inTenant(async (tx) =>
    createRecord(tx, await h.context(tx, users[user] ?? '', grants), object, input),
  );
const update = (
  user: string,
  object: string,
  id: string,
  input: WriteInput,
  version: number | null,
  grants?: Grants,
) =>
  h.inTenant(async (tx) =>
    updateRecord(tx, await h.context(tx, users[user] ?? '', grants), object, id, input, version),
  );
const stored = (object: string, id: string) =>
  h.inTenant(async (tx: TenantTransaction) => {
    const ctx = await h.context(tx, users['boss'] ?? '');
    const meta = ctx.metadata.object(object);
    if (!meta) throw new Error(object);
    return readStored(tx, meta, id);
  });
async function refused(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    if (err instanceof RecordError)
      return { status: err.status, errors: err.errors.map((e) => `${e.field}:${e.code}`) };
    throw err;
  }
  throw new Error('expected the write to be refused');
}
const lead = (extra: Record<string, unknown> = {}) => ({
  fields: { last_name: 'Chen', company: 'Pixelcraft', ...extra },
});

describe('createRecord (§3.7)', () => {
  it('applies defaults, numbers the record and records the create', async () => {
    const result = await create(
      'rep',
      'lead',
      lead({ email: 'maya@pixelcraft.example', annual_revenue: '1250.5' }),
    );
    expect(result).toMatchObject({ version: 1, recordNumber: 'L-000001' });
    expect(result.changed).toEqual(
      expect.arrayContaining(['last_name', 'company', 'status', 'owner_id', 'email']),
    );
    const row = await stored('lead', result.id);
    expect(row?.values).toMatchObject({
      owner_id: users['rep'],
      status: 'open',
      annual_revenue: '1250.50',
      record_number: 'L-000001',
      do_not_call: false,
    });
    expect(row?.currencyCode).toBe('USD');
    const [auditRow, event] = await h.inTenant(async ({ prisma: p }) => [
      await p.auditLog.findFirst({ where: { recordId: result.id } }),
      await p.outboxEvent.findFirst({ where: { aggregateId: result.id } }),
    ]);
    expect(auditRow).toMatchObject({ action: 'record.created', object: 'lead' });
    expect(JSON.stringify(auditRow?.payload)).not.toContain('maya@'); // names only, never values
    expect(event).toMatchObject({ topic: 'automation.record_created', aggregateType: 'lead' });
    expect((await create('rep', 'lead', lead())).recordNumber).toBe('L-000002');
  });

  it('stores custom fields in `custom`', async () => {
    await h.inTenant(async ({ prisma: p }) => {
      const object = await p.objectDefinition.findFirstOrThrow({ where: { apiName: 'lead' } });
      await p.fieldDefinition.create({
        data: { tenantId: T, objectId: object.id, apiName: 'budget__c', type: 'currency' },
      });
    });
    const grants = {
      fields: {
        ...allFields(),
        lead: { ...allFields()['lead'], budget__c: { read: true, edit: true } },
      },
    };
    const result = await create('rep', 'lead', lead({ budget__c: '99.999' }), grants);
    const row = await stored('lead', result.id);
    expect(row?.custom).toEqual({ budget__c: '100.00' });
    expect(row?.values['budget__c']).toBe('100.00');
  });

  it('refuses bad input with the right status and fields', async () => {
    expect(await refused(create('rep', 'lead', { fields: { company: 'X' } }))).toEqual({
      status: 422,
      errors: ['last_name:required'],
    });
    expect(await refused(create('rep', 'lead', lead({ nope: 1 })))).toEqual({
      status: 400,
      errors: ['nope:unknown_field'],
    });
    expect(await refused(create('rep', 'lead', lead({ record_number: 'L-9' })))).toEqual({
      status: 400,
      errors: ['record_number:read_only'],
    });
    expect(await refused(create('rep', 'lead', lead({ status: 'bogus', email: 'nope' })))).toEqual({
      status: 400,
      errors: ['status:not_in_picklist', 'email:invalid_format'],
    });
    expect(await refused(create('rep', 'lead', lead({ status: 'converted' })))).toEqual({
      status: 422,
      errors: ['status:converted_by_conversion'],
    });
    expect(await refused(create('rep', 'lead', { ...lead(), currencyCode: 'JPY' }))).toEqual({
      status: 422,
      errors: ['currency_code:inactive_currency'],
    });
    expect(await refused(create('rep', 'nope', lead()))).toMatchObject({ status: 404 });
  });

  it('enforces object permissions and field-level security', async () => {
    const readOnly = { objects: { lead: { ...FULL, create: false, edit: false, delete: false } } };
    expect(await refused(create('rep', 'lead', lead(), readOnly))).toEqual({
      status: 403,
      errors: [],
    });
    const hidden = { fields: allFields({ lead: ['email'] }) };
    expect(await refused(create('rep', 'lead', lead({ email: 'a@b.example' }), hidden))).toEqual({
      status: 403,
      errors: ['email:not_editable'],
    });
    expect(
      await refused(
        create('rep', 'account', { fields: { name: 'X' } }, { objects: { lead: FULL } }),
      ),
    ).toMatchObject({
      status: 404,
    });
  });

  it('only accepts references the writer can see', async () => {
    const hidden = await create('boss', 'campaign', { fields: { name: 'Boss only' } });
    expect(await refused(create('rep', 'lead', lead({ campaign_id: hidden.id })))).toEqual({
      status: 422,
      errors: ['campaign_id:invalid_reference'],
    });
    const mine = await create('rep', 'campaign', { fields: { name: 'Mine' } });
    await expect(create('rep', 'lead', lead({ campaign_id: mine.id }))).resolves.toMatchObject({
      version: 1,
    });
    expect(
      await refused(
        create('rep', 'lead', lead({ owner_id: '01920000-0000-7000-8000-00000000dead' })),
      ),
    ).toEqual({
      status: 422,
      errors: ['owner_id:invalid_reference'],
    });
  });
});

describe('updateRecord (§3.7)', () => {
  it('writes what changed, bumps the version and refuses stale versions', async () => {
    const { id } = await create('rep', 'lead', lead());
    const result = await update(
      'rep',
      'lead',
      id,
      { fields: { city: 'Doha', company: 'Pixelcraft' } },
      1,
    );
    expect(result).toMatchObject({ version: 2, changed: ['city'] });
    expect(await refused(update('rep', 'lead', id, { fields: { city: 'Dubai' } }, 1))).toEqual({
      status: 409,
      errors: ['_record:version_mismatch'],
    });
    expect(await refused(update('rep', 'lead', id, { fields: { last_name: '' } }, 2))).toEqual({
      status: 422,
      errors: ['last_name:required'],
    });
  });

  it('keeps tracked-field history', async () => {
    await h.inTenant(({ prisma: p }) =>
      p.fieldDefinition.updateMany({
        where: { apiName: 'status', object: { apiName: 'lead' } },
        data: { trackHistory: true },
      }),
    );
    const { id } = await create('rep', 'lead', lead());
    await update('rep', 'lead', id, { fields: { status: 'working' } }, 1);
    const history = await h.inTenant(({ prisma: p }) =>
      p.fieldHistory.findMany({ where: { recordId: id } }),
    );
    expect(history).toMatchObject([
      { field: 'status', oldValue: 'open', newValue: 'working', changedBy: users['rep'] },
    ]);
  });

  it('follows sharing: not found for the invisible, forbidden without edit or transfer access', async () => {
    const { id } = await create('peer', 'lead', lead());
    expect(await refused(update('rep', 'lead', id, { fields: { city: 'X' } }, null))).toEqual({
      status: 404,
      errors: [],
    });
    await h.inTenant(({ prisma: p }) =>
      p.recordShare.create({
        data: {
          tenantId: T,
          object: 'lead',
          recordId: id,
          principalType: 'USER',
          principalId: users['rep'] ?? '',
          access: 1,
          reason: 'MANUAL',
        },
      }),
    );
    expect(await refused(update('rep', 'lead', id, { fields: { city: 'X' } }, null))).toEqual({
      status: 403,
      errors: [],
    });
    await h.inTenant(({ prisma: p }) =>
      p.recordShare.updateMany({ where: { recordId: id }, data: { access: 2 } }),
    );
    await expect(update('rep', 'lead', id, { fields: { city: 'X' } }, null)).resolves.toMatchObject(
      { version: 2 },
    );
    expect(
      await refused(update('rep', 'lead', id, { fields: { owner_id: users['rep'] } }, null)),
    ).toEqual({
      status: 403,
      errors: ['owner_id:transfer_not_allowed'],
    });
    // The manager above the owner has Full access and can transfer it.
    await expect(
      update('boss', 'lead', id, { fields: { owner_id: users['rep'] } }, null),
    ).resolves.toMatchObject({
      changed: ['owner_id'],
    });
  });

  it('refuses edits to converted leads', async () => {
    const { id } = await create('rep', 'lead', lead());
    await h.inTenant(({ prisma: p }) =>
      p.lead.update({
        where: { tenantId_id: { tenantId: T, id } },
        data: { convertedAt: new Date() },
      }),
    );
    expect(await refused(update('rep', 'lead', id, { fields: { city: 'X' } }, null))).toEqual({
      status: 409,
      errors: ['_record:record_locked'],
    });
  });
});

describe('validation rules (§5.5)', () => {
  it('rejects saves a rule flags, with its message, including cross-object rules', async () => {
    await h.inTenant(async ({ prisma: p }) => {
      const leadObject = await p.objectDefinition.findFirstOrThrow({ where: { apiName: 'lead' } });
      const contactObject = await p.objectDefinition.findFirstOrThrow({
        where: { apiName: 'contact' },
      });
      await p.validationRule.createMany({
        data: [
          {
            tenantId: T,
            objectId: leadObject.id,
            apiName: 'working_needs_email',
            formula: "ISPICKVAL(status, 'working') && ISBLANK(email)",
            errorMessage: 'Add an email before you start working the lead.',
            errorField: 'email',
          },
          {
            tenantId: T,
            objectId: contactObject.id,
            apiName: 'bank_accounts_only',
            formula: "NOT(ISBLANK(account_id)) && account.name != 'Aurelia Bank'",
            errorMessage: 'Contacts belong to the bank.',
          },
        ],
      });
    });
    const { id } = await create('rep', 'lead', lead());
    const error = await h
      .inTenant(async (tx) =>
        updateRecord(
          tx,
          await h.context(tx, users['rep'] ?? ''),
          'lead',
          id,
          { fields: { status: 'working' } },
          null,
        ),
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RecordError);
    expect((error as RecordError).errors).toEqual([
      {
        field: 'email',
        code: 'validation_rule',
        message: 'Add an email before you start working the lead.',
      },
    ]);
    await expect(
      update('rep', 'lead', id, { fields: { status: 'working', email: 'x@y.example' } }, null),
    ).resolves.toMatchObject({ version: 2 });

    const bank = await create('rep', 'account', { fields: { name: 'Aurelia Bank' } });
    const other = await create('rep', 'account', { fields: { name: 'Other' } });
    await expect(
      create('rep', 'contact', { fields: { last_name: 'Ivy', account_id: bank.id } }),
    ).resolves.toMatchObject({ version: 1 });
    expect(
      await refused(
        create('rep', 'contact', { fields: { last_name: 'Jay', account_id: other.id } }),
      ),
    ).toEqual({
      status: 422,
      errors: ['_record:validation_rule'],
    });
  });
});

describe('opportunities (§4.5) and money (Q13)', () => {
  const opp = (extra: Record<string, unknown> = {}) => ({
    fields: { name: 'Big deal', close_date: '2026-10-15', ...extra },
  });

  it('takes the pipeline, first stage and stage defaults', async () => {
    const { id } = await create('rep', 'opportunity', opp({ amount: '1000' }));
    const row = await stored('opportunity', id);
    expect(row?.values).toMatchObject({
      stage: 'qualification',
      probability: '10.00',
      forecast_category: 'pipeline',
      is_closed: false,
      is_won: false,
      amount: '1000.00',
    });
    const won = await update('rep', 'opportunity', id, { fields: { stage: 'closed_won' } }, 1);
    expect(won.version).toBe(2);
    expect((await stored('opportunity', id))?.values).toMatchObject({
      probability: '100.00',
      forecast_category: 'closed',
      is_closed: true,
      is_won: true,
    });
    const history = await h.inTenant(({ prisma: p }) =>
      p.opportunityStageHistory.findMany({
        where: { opportunityId: id },
        orderBy: { changedAt: 'asc' },
      }),
    );
    expect(history.map((r) => r.stage)).toEqual(['qualification', 'closed_won']);
  });

  it('needs a loss reason when lost, and a stage of the pipeline', async () => {
    const { id } = await create('rep', 'opportunity', opp());
    expect(
      await refused(update('rep', 'opportunity', id, { fields: { stage: 'closed_lost' } }, null)),
    ).toEqual({
      status: 422,
      errors: ['loss_reason:required'],
    });
    await expect(
      update(
        'rep',
        'opportunity',
        id,
        { fields: { stage: 'closed_lost', loss_reason: 'price' } },
        null,
      ),
    ).resolves.toMatchObject({ version: 2 });
    expect(await refused(create('rep', 'opportunity', opp({ stage: 'nope' })))).toEqual({
      status: 422,
      errors: ['stage:not_in_pipeline'],
    });
  });

  it('converts money to the corporate currency at the close date', async () => {
    const { id } = await create('rep', 'opportunity', {
      ...opp({ amount: '900', close_date: '2026-09-30' }),
      currencyCode: 'EUR',
    });
    const corporate = async () =>
      h.inTenant(({ prisma: p }) =>
        p.opportunity.findUniqueOrThrow({ where: { tenantId_id: { tenantId: T, id } } }),
      );
    let row = await corporate();
    expect([
      row.amountCorporate?.toString(),
      row.corporateRateDate?.toISOString().slice(0, 10),
    ]).toEqual(['1125', '2026-01-01']);
    // Moving the close date past a new rate re-converts at that rate.
    await update('rep', 'opportunity', id, { fields: { close_date: '2026-10-05' } }, null);
    row = await corporate();
    expect([
      row.amountCorporate?.toString(),
      row.corporateRateDate?.toISOString().slice(0, 10),
    ]).toEqual(['1000', '2026-10-01']);
  });
});

describe('sharing rules on write (§6.4)', () => {
  it('shares a new record that matches a criteria rule, and unshares it when it stops matching', async () => {
    const group = await h.inTenant(({ prisma: p }) =>
      p.publicGroup.create({ data: { tenantId: T, name: 'Doha team' } }),
    );
    await h.inTenant(({ prisma: p }) =>
      p.sharingRule.create({
        data: {
          tenantId: T,
          object: 'lead',
          name: 'Doha leads',
          kind: 'CRITERIA',
          criteria: { field: 'city', op: 'eq', value: 'Doha' },
          targetType: 'GROUP',
          targetId: group.id,
          access: 1,
        },
      }),
    );
    const { id } = await create('rep', 'lead', lead({ city: 'Doha' }));
    const shares = () =>
      h.inTenant(({ prisma: p }) =>
        p.recordShare.count({ where: { recordId: id, reason: 'RULE' } }),
      );
    expect(await shares()).toBe(1);
    await update('rep', 'lead', id, { fields: { city: 'Dubai' } }, null);
    expect(await shares()).toBe(0);
  });
});
