import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { backfillDerivedColumns, createRecord, DERIVED_VERSION } from '../src/index.js';
import { startHarness, type Harness } from './support.js';

const T = '01920000-0000-7000-8000-000000000d07';
let h: Harness;
let user = '';

beforeAll(async () => {
  h = await startHarness(T);
  user = await h.user('rep');
});

afterAll(async () => {
  await h.dispose();
});

type Keys = Record<string, string | null>;
const leadKeys = (id: string) =>
  h.inTenant(async (tx) => {
    const rows = await sql<Keys>`SELECT match_email, match_email_domain, match_phone, match_mobile,
      match_name_key, match_company_key FROM lead WHERE id = ${id}::uuid`.execute(tx.kysely);
    return rows.rows[0];
  });

describe('duplicate-matching keys (§7.2, migration 0022)', () => {
  it('are kept current by trigger on every write', async () => {
    const id = await h.inTenant(async (tx) => {
      const ctx = await h.context(tx, user);
      const created = await createRecord(tx, ctx, 'lead', {
        fields: {
          last_name: 'Haddad',
          company: 'Gulf Trading W.L.L.',
          email: 'Omar.Haddad@GulfTrading.example',
          phone: '+974 5550 1234',
        },
      });
      return created.id;
    });
    expect(await leadKeys(id)).toEqual({
      match_email: 'omar.haddad@gulftrading.example',
      match_email_domain: 'gulftrading.example',
      match_phone: '55501234',
      match_mobile: null,
      match_name_key: 'HTT',
      match_company_key: 'gulf trading',
    });
  });

  it('are backfilled per tenant for rows written before the trigger, once', async () => {
    const id = await h.inTenant(async (tx) => {
      const ctx = await h.context(tx, user);
      return (
        await createRecord(tx, ctx, 'lead', {
          fields: { last_name: 'Hadad', company: 'The Gulf Trading Co.', phone: '5550 1234' },
        })
      ).id;
    });
    // As if written before migration 0022: no keys, and the tenant behind DERIVED_VERSION.
    await h.inTenant(async (tx) => {
      await sql`UPDATE lead SET match_name_key = NULL, match_company_key = NULL, match_phone = NULL
        WHERE id = ${id}::uuid`.execute(tx.kysely);
      await tx.prisma.tenantSettings.update({
        where: { tenantId: T },
        data: { derivedVersion: 0 },
      });
    });
    const rows = await backfillDerivedColumns((fn) => h.inTenant(fn), { batch: 1 });
    expect(rows).toBeGreaterThanOrEqual(2);
    expect(await leadKeys(id)).toMatchObject({
      match_name_key: 'HTT',
      match_company_key: 'gulf trading',
      match_phone: '55501234',
    });
    const settings = await h.inTenant((tx) =>
      tx.prisma.tenantSettings.findUniqueOrThrow({ where: { tenantId: T } }),
    );
    expect(settings.derivedVersion).toBe(DERIVED_VERSION);
    // Current tenants cost nothing.
    expect(await backfillDerivedColumns((fn) => h.inTenant(fn))).toBe(0);
  });
});
