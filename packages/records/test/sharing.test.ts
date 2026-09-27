import type { TenantTransaction } from '@sm/db';
import { sharingPredicate } from '@sm/query-engine';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRecord,
  deleteRecord,
  listTeam,
  loadRecordContext,
  RecordError,
  removeTeamMember,
  setTeamMember,
  undeleteRecord,
  updateRecord,
  type RecordContext,
} from '../src/index.js';
import { startHarness, type Harness } from './support.js';

const T = '01920000-0000-7000-8000-000000000d05';
let h: Harness;
const users: Record<string, string> = {};
const u = (name: string) => users[name] ?? '';

beforeAll(async () => {
  h = await startHarness(T);
  await h.unit('sales');
  await h.unit('emea', 'sales');
  await h.unit('ops');
  users['boss'] = await h.user('boss', 'sales');
  users['rep'] = await h.user('rep', 'emea');
  users['peer'] = await h.user('peer', 'emea');
  users['out'] = await h.user('out', 'ops');
  users['out2'] = await h.user('out2', 'ops');
  for (const name of Object.keys(users)) await h.grant(u(name));
});

afterAll(async () => {
  await h.dispose();
});

const as = <T>(user: string, fn: (tx: TenantTransaction, ctx: RecordContext) => Promise<T>) =>
  h.inTenant(async (tx) => fn(tx, await loadRecordContext(tx, u(user))));
const create = (user: string, object: string, fields: Record<string, unknown>) =>
  as(user, async (tx, ctx) => (await createRecord(tx, ctx, object, { fields })).id);
const update = (user: string, object: string, id: string, fields: Record<string, unknown>) =>
  as(user, (tx, ctx) => updateRecord(tx, ctx, object, id, { fields }, null));
/** The highest access `user` has to the record: none, read, edit or full. */
const access = (user: string, object: string, id: string) =>
  as(user, async (tx, ctx) => {
    let best = 'none';
    for (const level of ['read', 'edit', 'full'] as const) {
      const rows = await sql`SELECT 1 FROM ${sql.table(object)} AS r
        WHERE r.tenant_id = ${T}::uuid AND r.id = ${id}::uuid AND r.deleted_at IS NULL
          AND ${sharingPredicate(ctx.sharing, object, 'r', level)}`.execute(tx.kysely);
      if (rows.rows.length) best = level;
    }
    return best;
  });
const shares = (object: string, id: string) =>
  h.inTenant(async ({ prisma }) =>
    (
      await prisma.recordShare.findMany({
        where: {
          object,
          recordId: id,
          reason: { in: ['TEAM', 'IMPLICIT_PARENT', 'IMPLICIT_CHILD'] },
        },
      })
    )
      .map((s) => `${s.reason} ${s.principalType} ${s.principalId} ${String(s.access)}`)
      .sort(),
  );
async function refused(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    if (err instanceof RecordError)
      return `${String(err.status)} ${err.errors.map((e) => e.code).join()}`;
    throw err;
  }
  return 'accepted';
}

let account = '';
let opp = '';
let contact = '';

describe('implicit sharing between accounts and their children (§6.3)', () => {
  it('gives child owners Read on the account and the account owner Read on its opportunities', async () => {
    account = await create('rep', 'account', { name: 'Umbrella' });
    opp = await create('rep', 'opportunity', {
      name: 'Umbrella expansion',
      account_id: account,
      stage: 'qualification',
      close_date: '2026-12-01',
    });
    contact = await create('rep', 'contact', { last_name: 'Wesker', account_id: account });
    // One owner for everything: nothing to derive.
    expect(await shares('account', account)).toEqual([]);
    expect(await shares('opportunity', opp)).toEqual([]);
    expect(await access('peer', 'account', account)).toBe('none');

    await update('rep', 'opportunity', opp, { owner_id: u('peer') });
    expect(await shares('account', account)).toEqual([`IMPLICIT_PARENT USER ${u('peer')} 1`]);
    expect(await shares('opportunity', opp)).toEqual([`IMPLICIT_CHILD USER ${u('rep')} 1`]);
    expect(await access('peer', 'account', account)).toBe('read');
    expect(await access('rep', 'opportunity', opp)).toBe('read');
    // Contacts follow the account (CONTROLLED_BY_PARENT): the peer reads them through it.
    expect(await access('peer', 'contact', contact)).toBe('read');
  });

  it('follows owner, account and delete changes', async () => {
    // The account changes hands: the implicit child share moves to the new owner.
    await update('rep', 'account', account, { owner_id: u('out') });
    expect(await shares('opportunity', opp)).toEqual([`IMPLICIT_CHILD USER ${u('out')} 1`]);
    expect(await access('out', 'opportunity', opp)).toBe('read');
    // The contact's owner (rep) now needs the implicit parent share too.
    expect(await shares('account', account)).toEqual(
      [`IMPLICIT_PARENT USER ${u('peer')} 1`, `IMPLICIT_PARENT USER ${u('rep')} 1`].sort(),
    );
    // Delete and restore the opportunity: its implicit shares go and come back.
    await as('peer', (tx, ctx) => deleteRecord(tx, ctx, 'opportunity', opp));
    expect(await shares('account', account)).toEqual([`IMPLICIT_PARENT USER ${u('rep')} 1`]);
    await as('peer', (tx, ctx) => undeleteRecord(tx, ctx, 'opportunity', opp));
    expect(await shares('account', account)).toContain(`IMPLICIT_PARENT USER ${u('peer')} 1`);
    expect(await shares('opportunity', opp)).toEqual([`IMPLICIT_CHILD USER ${u('out')} 1`]);
    // The opportunity moves to another account: the old account forgets the peer.
    const other = await create('peer', 'account', { name: 'Tyrell' });
    await update('peer', 'opportunity', opp, { account_id: other });
    expect(await shares('account', account)).toEqual([`IMPLICIT_PARENT USER ${u('rep')} 1`]);
    expect(await shares('opportunity', opp)).toEqual([]);
  });
});

describe('account and opportunity teams (§6.3)', () => {
  let opp2 = '';
  it('shares the account, and its opportunities per the membership', async () => {
    opp2 = await create('rep', 'opportunity', {
      name: 'Umbrella renewal',
      account_id: account,
      stage: 'qualification',
      close_date: '2026-12-01',
    });
    expect(await access('out2', 'account', account)).toBe('none');
    await as('out', (tx, ctx) =>
      setTeamMember(tx, ctx, 'account', account, {
        userId: u('out2'),
        role: 'Solution engineer',
        access: 2,
        opportunityAccess: 1,
      }),
    );
    expect(await access('out2', 'account', account)).toBe('edit');
    expect(await access('out2', 'opportunity', opp2)).toBe('read');
    expect(await access('out2', 'contact', contact)).toBe('edit');
    expect(await as('out2', (tx, ctx) => listTeam(tx, ctx, 'account', account))).toMatchObject([
      { userId: u('out2'), role: 'Solution engineer', access: 2, opportunityAccess: 1 },
    ]);
    // Changing the membership changes the shares.
    await as('out', (tx, ctx) =>
      setTeamMember(tx, ctx, 'account', account, { userId: u('out2'), access: 1 }),
    );
    expect(await access('out2', 'account', account)).toBe('read');
    expect(await access('out2', 'opportunity', opp2)).toBe('none');
    await as('out', (tx, ctx) => removeTeamMember(tx, ctx, 'account', account, u('out2')));
    expect(await access('out2', 'account', account)).toBe('none');
    const audits = await h.inTenant(({ prisma }) =>
      prisma.auditLog.count({
        where: { recordId: account, action: { startsWith: 'record.team' } },
      }),
    );
    expect(audits).toBe(3);
  });

  it('lets only users with Full access change a team', async () => {
    // The rep reads the account (their contact's implicit parent) but does not control it.
    expect(
      await refused(
        as('rep', (tx, ctx) =>
          setTeamMember(tx, ctx, 'account', account, { userId: u('out2'), access: 1 }),
        ),
      ),
    ).toBe('403 team_not_allowed');
    expect(
      await refused(
        as('out2', (tx, ctx) =>
          setTeamMember(tx, ctx, 'account', account, { userId: u('out2'), access: 1 }),
        ),
      ),
    ).toBe('404 ');
    expect(await refused(as('out2', (tx, ctx) => listTeam(tx, ctx, 'account', account)))).toBe(
      '404 ',
    );
    // The opportunity's owner manages its team; the account owner (Read) does not.
    expect(
      await refused(
        as('out', (tx, ctx) =>
          setTeamMember(tx, ctx, 'opportunity', opp2, { userId: u('out2'), access: 2 }),
        ),
      ),
    ).toBe('403 team_not_allowed');
    await as('rep', (tx, ctx) =>
      setTeamMember(tx, ctx, 'opportunity', opp2, { userId: u('out2'), access: 2 }),
    );
    expect(await access('out2', 'opportunity', opp2)).toBe('edit');
    expect(await as('rep', (tx, ctx) => listTeam(tx, ctx, 'opportunity', opp2))).toMatchObject([
      { userId: u('out2'), access: 2, opportunityAccess: null },
    ]);
    await as('rep', (tx, ctx) => removeTeamMember(tx, ctx, 'opportunity', opp2, u('out2')));
    expect(await access('out2', 'opportunity', opp2)).toBe('none');
  });

  it('validates memberships', async () => {
    const set = (
      input: Parameters<typeof setTeamMember>[4],
      object: 'account' | 'opportunity' = 'account',
    ) =>
      refused(
        as('out', (tx, ctx) =>
          setTeamMember(tx, ctx, object, object === 'account' ? account : opp2, input),
        ),
      );
    expect(await set({ userId: u('out2'), access: 3 as never })).toBe('400 invalid_access');
    expect(await set({ userId: u('out2'), access: 1, opportunityAccess: 5 as never })).toBe(
      '400 invalid_access',
    );
    expect(await set({ userId: '01920000-0000-7000-8000-00000000beef', access: 1 })).toBe(
      '400 invalid_reference',
    );
    expect(
      await refused(
        as('rep', (tx, ctx) =>
          setTeamMember(tx, ctx, 'opportunity', opp2, {
            userId: u('out2'),
            access: 1,
            opportunityAccess: 1,
          }),
        ),
      ),
    ).toBe('400 not_applicable');
    expect(
      await refused(
        as('out', (tx, ctx) => removeTeamMember(tx, ctx, 'account', account, u('boss'))),
      ),
    ).toBe('404 ');
  });
});
