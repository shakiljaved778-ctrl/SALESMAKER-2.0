import { withTenant } from '@sm/db';
import { FakeStorageProvider } from '@sm/integrations';
import { startHarness, type Harness } from '@sm/records/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';

import {
  dryRunImport,
  runImport,
  undoable,
  undoImport,
  type ColumnMapping,
  type ImportDeps,
} from '../src/index.js';

const T = '01920000-0000-7000-8000-0000000001a1';
let h: Harness;
let rep = '';
let dee = '';
let matching = '';
let assign = '';
const storage = new FakeStorageProvider();
let deps: ImportDeps;

beforeAll(async () => {
  h = await startHarness(T, inject('pgServerAdminUrl'));
  rep = await h.user('rep');
  dee = await h.user('dee');
  await h.grant(rep);
  deps = {
    storage,
    inTenant: (fn) =>
      withTenant(h.prisma, { tenantId: T }, fn, { timeoutMs: 60_000, statementTimeoutMs: 30_000 }),
  };
  await h.inTenant(async ({ prisma: p }) => {
    matching = (
      await p.matchingRule.create({
        data: {
          tenantId: T,
          object: 'lead',
          name: 'Email',
          conditions: [{ field: 'email', method: 'email' }] as never,
        },
      })
    ).id;
    const rule = await p.assignmentRule.create({
      data: { tenantId: T, object: 'lead', name: 'To dee' },
    });
    await p.assignmentRuleEntry.create({
      data: { tenantId: T, ruleId: rule.id, method: 'SPECIFIC_USER', targetUserId: dee },
    });
    assign = rule.id;
  });
});

afterAll(async () => {
  await h.dispose();
});

const MAPPING: ColumnMapping[] = [
  { column: 0, field: 'last_name' },
  { column: 1, field: 'company' },
  { column: 2, field: 'email' },
  { column: 3, field: 'lead_source', values: { Website: 'web' } },
  { column: 4, field: 'owner_id', ownerBy: 'email' },
];

let n = 0;
async function job(csv: string, extra: Record<string, unknown> = {}) {
  n += 1;
  const key = `${T}/2026/10/file-${String(n)}.csv`;
  await storage.putObject(key, Buffer.from(csv), 'text/csv');
  return h.inTenant(
    async ({ prisma: p }) =>
      (
        await p.importJob.create({
          data: {
            tenantId: T,
            object: 'lead',
            status: 'QUEUED',
            fileName: 'leads.csv',
            fileKey: key,
            fileSize: BigInt(csv.length),
            fileType: 'csv',
            mapping: MAPPING as never,
            createdBy: rep,
            ...extra,
          },
        })
      ).id,
  );
}
const row = (cells: string[]) => cells.join(',');
const header = 'Last,Company,Email,Source,Owner';
const read = (id: string) =>
  h.inTenant(({ prisma: p }) => p.importJob.findFirstOrThrow({ where: { id } }));
const results = (id: string) =>
  h.inTenant(({ prisma: p }) =>
    p.importRowResult.findMany({ where: { importJobId: id }, orderBy: { rowNumber: 'asc' } }),
  );

describe('imports (§7.1)', () => {
  it('dry-runs the first rows without writing anything', async () => {
    const id = await job(
      [
        header,
        row(['Dry', 'C', 'dry@x.example', 'Website', '']),
        row(['', 'C', 'bad', '', '']),
      ].join('\n'),
      { status: 'READY' },
    );
    await dryRunImport(deps, id);
    const after = await read(id);
    expect(after.dryRun).toMatchObject({ rows: 2, created: 1, failed: 1 });
    expect(JSON.stringify(after.dryRun)).toContain('email:invalid_format');
    expect(await h.inTenant(({ prisma: p }) => p.lead.count())).toBe(0);
  });

  it('creates through RecordService with owners by email, failures per row, and a results file', async () => {
    const id = await job(
      [
        header,
        row(['Haddad', 'Gulf', 'omar@gulf.example', 'Website', 'dee@records.test']),
        row(['Chen', 'Pixel', 'not-an-email', '', '']),
        row(['Okafor', 'Delta', '', '', 'nobody@x.example']),
        row(['Silva', 'Mar', 'silva@mar.example', 'partner_referral', '']),
      ].join('\n'),
    );
    await runImport(deps, id, { batch: 2 });
    const done = await read(id);
    expect(done).toMatchObject({
      status: 'COMPLETED',
      total: 4,
      processed: 4,
      created: 2,
      failed: 2,
    });
    const rows = await results(id);
    expect(rows.map((r) => [r.rowNumber, r.status])).toEqual([
      [2, 'CREATED'],
      [3, 'FAILED'],
      [4, 'FAILED'],
      [5, 'CREATED'],
    ]);
    expect(JSON.stringify(rows[2]?.errors)).toContain('unknown_owner');
    const created = await h.inTenant(({ prisma: p }) =>
      p.lead.findFirstOrThrow({ where: { id: rows[0]?.recordId ?? '' } }),
    );
    expect(created).toMatchObject({ ownerId: dee, leadSource: 'web' });
    const file = storage.objects.get(done.resultFileKey ?? '')?.body?.toString('utf8') ?? '';
    expect(file.split('\n')[0]).toBe('row,status,record_id,errors');
    expect(file).toContain('3,FAILED,,email:invalid_format');
    // A redelivered job does not run twice.
    await runImport(deps, id);
    expect((await read(id)).created).toBe(2);
  });

  it('skips, updates or creates rows that duplicate existing leads, as asked', async () => {
    const csv = [
      header,
      row(['Haddad', 'Gulf', 'OMAR@gulf.example', '', '']),
      row(['New', 'N', 'new@n.example', '', '']),
    ].join('\n');
    const skip = await job(csv, { matchingRuleId: matching, duplicateMode: 'SKIP' });
    await runImport(deps, skip);
    expect((await results(skip)).map((r) => r.status)).toEqual(['SKIPPED', 'CREATED']);
    const update = await job(
      [header, row(['Haddad-Updated', 'Gulf', 'omar@gulf.example', '', ''])].join('\n'),
      { matchingRuleId: matching, duplicateMode: 'UPDATE' },
    );
    await runImport(deps, update);
    const [updated] = await results(update);
    // dee owns that lead; rep cannot see it, so it cannot be updated.
    expect(updated).toMatchObject({ status: 'FAILED' });
    expect(JSON.stringify(updated?.errors)).toContain('duplicate_not_visible');
    const mine = await job([header, row(['Mine', 'M', 'mine@m.example', '', ''])].join('\n'));
    await runImport(deps, mine);
    const again = await job(
      [header, row(['Mine Again', 'M', 'mine@m.example', '', ''])].join('\n'),
      {
        matchingRuleId: matching,
        duplicateMode: 'UPDATE',
      },
    );
    await runImport(deps, again);
    const [up] = await results(again);
    expect(up).toMatchObject({ status: 'UPDATED' });
    expect(
      (
        await h.inTenant(({ prisma: p }) =>
          p.lead.findFirstOrThrow({ where: { id: up?.recordId ?? '' } }),
        )
      ).lastName,
    ).toBe('Mine Again');
    const create = await job([header, row(['Twin', 'M', 'mine@m.example', '', ''])].join('\n'), {
      matchingRuleId: matching,
      duplicateMode: 'CREATE',
    });
    await runImport(deps, create);
    expect((await results(create)).map((r) => r.status)).toEqual(['CREATED']);
  });

  it('runs assignment on imported records when asked', async () => {
    const id = await job([header, row(['Routed', 'R', '', '', ''])].join('\n'), {
      runAssignment: true,
      assignmentRuleId: assign,
    });
    await runImport(deps, id);
    const [r] = await results(id);
    const log = await h.inTenant(({ prisma: p }) =>
      p.assignmentLog.findFirstOrThrow({ where: { recordId: r?.recordId ?? '' } }),
    );
    expect(log).toMatchObject({ source: 'import', ownerId: dee });
  });

  it('undoes an import within 72 hours: created records go to the recycle bin', async () => {
    const id = await job(
      [header, row(['Undo1', 'U', '', '', '']), row(['Undo2', 'U', '', '', ''])].join('\n'),
    );
    await runImport(deps, id);
    const done = await read(id);
    expect(undoable(done)).toBe(true);
    expect(undoable({ ...done, finishedAt: new Date(Date.now() - 73 * 3_600_000) })).toBe(false);
    expect(undoable({ ...done, status: 'FAILED' })).toBe(false);
    await h.inTenant(({ prisma: p }) =>
      p.importJob.update({
        where: { tenantId_id: { tenantId: T, id } },
        data: { status: 'UNDOING' },
      }),
    );
    expect(await undoImport(deps, id)).toEqual({ deleted: 2, kept: 0 });
    expect((await read(id)).status).toBe('UNDONE');
    const ids = (await results(id)).map((r) => r.recordId ?? '');
    const live = await h.inTenant(({ prisma: p }) =>
      p.lead.count({ where: { id: { in: ids }, deletedAt: null } }),
    );
    expect(live).toBe(0);
    // Only an UNDOING job is undone.
    expect(await undoImport(deps, id)).toBeNull();
  });

  it('fails the job when the file cannot be read', async () => {
    const id = await job('x', { fileType: 'xlsx' });
    await runImport(deps, id);
    expect(await read(id)).toMatchObject({
      status: 'FAILED',
      error: expect.stringContaining('XLSX') as unknown,
    });
  });
});
