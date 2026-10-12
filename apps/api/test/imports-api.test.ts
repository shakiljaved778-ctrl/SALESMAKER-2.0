import { withTenant, type TenantTransaction } from '@sm/db';
import { dryRunImport, runImport, undoImport } from '@sm/imports';
import { DomainError } from '@sm/server-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ImportsService } from '../src/records/imports.service.js';
import { setupFixture, type SetupFixture } from './setup-fixture.js';

let f: SetupFixture;
type Json = Record<string, unknown>;
const json = (res: { body: string }) => JSON.parse(res.body) as Json;
const firstError = (res: { body: string }) => (json(res)['errors'] as Json[] | undefined)?.[0];

const CSV = [
  'First Name,Last Name,Company,Email,Annual Revenue',
  'Ada,Lovelace,Analytical,ada@imports.test,"1,200"',
  'Alan,Turing,Bletchley,alan@imports.test,lots',
  'Grace,Hopper,Navy,grace@imports.test,900',
  ',,,,',
  'Dup,Licate,Existing,existing@imports.test,10',
].join('\n');

const deps = () => ({
  inTenant: <T>(fn: (tx: TenantTransaction) => Promise<T>) =>
    withTenant(f.prisma, { tenantId: f.tenantId }, fn, { timeoutMs: 60_000 }),
  storage: f.api.storage,
});

beforeAll(async () => {
  f = await setupFixture('imports');
  // The rep imports; the viewer only reads Setup (no import_records).
  await f.inTenant(async (tx) => {
    const set = await tx.prisma.permissionSet.create({
      data: { tenantId: f.tenantId, name: 'Importer' },
    });
    await tx.prisma.systemPermission.create({
      data: { tenantId: f.tenantId, permissionSetId: set.id, name: 'import_records' },
    });
    await tx.prisma.permissionAssignment.create({
      data: { tenantId: f.tenantId, userId: f.id('rep'), permissionSetId: set.id },
    });
  });
});

afterAll(async () => {
  await f.api.dispose();
});

/** Create a job as `user` and put the file where the upload URL points. */
async function upload(user = 'rep', body = CSV, fileName = 'leads.csv') {
  const bytes = Buffer.from(body);
  const res = await f.call(user, 'POST', '/v1/imports', {
    object: 'lead',
    fileName,
    fileType: fileName.endsWith('.xlsx') ? 'xlsx' : 'csv',
    fileSize: bytes.length,
  });
  expect(res.statusCode, res.body).toBe(201);
  const out = json(res) as { job: Json & { id: string }; upload: Json };
  const job = await f.inTenant((tx) =>
    tx.prisma.importJob.findFirstOrThrow({ where: { id: out.job.id } }),
  );
  return {
    ...out,
    id: out.job.id,
    put: () => f.api.storage.putObject(job.fileKey, bytes, 'text/csv'),
  };
}

describe('importing a file', () => {
  it('uploads, analyses, maps, dry runs, runs, reports and undoes', async () => {
    const existing = await f.call('rep', 'POST', '/v1/records/lead', {
      fields: { last_name: 'Existing', company: 'X', email: 'existing@imports.test' },
    });
    expect(existing.statusCode, existing.body).toBe(201);
    const rule = await f.call('admin', 'POST', '/v1/setup/matching-rules', {
      object: 'lead',
      name: 'Email',
      conditions: [{ field: 'email', method: 'email' }],
    });
    expect(rule.statusCode, rule.body).toBe(201);

    const job = await upload();
    expect(job.job).toMatchObject({
      status: 'UPLOADED',
      fileType: 'csv',
      createdBy: { id: f.id('rep') },
    });
    expect(job.upload).toMatchObject({
      method: 'PUT',
      headers: { 'content-type': 'text/csv' },
      url: expect.stringContaining('https://storage.fake/upload/') as unknown,
    });
    // Nothing to read until the browser has uploaded the file.
    expect((await f.call('rep', 'POST', `/v1/imports/${job.id}/analyse`, {})).statusCode).toBe(409);
    await job.put();

    const analysed = await f.call('rep', 'POST', `/v1/imports/${job.id}/analyse`, {});
    expect(analysed.statusCode, analysed.body).toBe(200);
    const analysis = json(analysed) as { job: Json & { version: number }; suggestions: Json[] };
    expect(analysis).toMatchObject({
      sheets: [],
      headers: ['First Name', 'Last Name', 'Company', 'Email', 'Annual Revenue'],
      templates: [],
    });
    // Up to five rows after the headers, blank ones included (the run reports them).
    const sample = (analysis as unknown as { sample: string[][] }).sample;
    expect(sample).toHaveLength(5);
    expect(sample[0]).toEqual(['Ada', 'Lovelace', 'Analytical', 'ada@imports.test', '1,200']);
    expect(sample[3]).toEqual(['', '', '', '', '']);
    expect(analysis.suggestions).toEqual([
      { column: 0, field: 'first_name' },
      { column: 1, field: 'last_name' },
      { column: 2, field: 'company' },
      { column: 3, field: 'email' },
      { column: 4, field: 'annual_revenue' },
    ]);

    // Skipping duplicates needs a matching rule.
    const noRule = await f.call('rep', 'PATCH', `/v1/imports/${job.id}`, {
      mapping: analysis.suggestions,
      duplicateMode: 'SKIP',
      version: analysis.job.version,
    });
    expect(firstError(noRule)).toMatchObject({ field: 'matchingRuleId', code: 'required' });
    const mapped = await f.call('rep', 'PATCH', `/v1/imports/${job.id}`, {
      mapping: analysis.suggestions,
      duplicateMode: 'SKIP',
      matchingRuleId: json(rule)['id'],
      defaults: { lead_source: 'web' },
      version: analysis.job.version,
    });
    expect(mapped.statusCode, mapped.body).toBe(200);
    const stale = await f.call('rep', 'PATCH', `/v1/imports/${job.id}`, {
      duplicateMode: 'CREATE',
      version: analysis.job.version,
    });
    expect(stale.statusCode).toBe(409);

    // Dry run: queued for the worker, then READY with what would happen, nothing saved.
    const dry = await f.call('rep', 'POST', `/v1/imports/${job.id}/dry-run`);
    expect(dry.statusCode, dry.body).toBe(202);
    expect(
      await f.inTenant((tx) =>
        tx.prisma.outboxEvent.count({ where: { topic: 'import.dry_run', aggregateId: job.id } }),
      ),
    ).toBe(1);
    await dryRunImport(deps(), job.id);
    const ready = json(await f.call('rep', 'GET', `/v1/imports/${job.id}`));
    expect(ready).toMatchObject({
      status: 'READY',
      dryRun: { rows: 4, created: 2, skipped: 1, failed: 1 },
    });
    expect(
      await f.inTenant((tx) => tx.prisma.importRowResult.count({ where: { importJobId: job.id } })),
    ).toBe(0);

    // Run it.
    const started = await f.call('rep', 'POST', `/v1/imports/${job.id}/start`);
    expect(started.statusCode, started.body).toBe(202);
    expect(json(started)['status']).toBe('QUEUED');
    expect((await f.call('rep', 'POST', `/v1/imports/${job.id}/analyse`, {})).statusCode).toBe(409);
    expect((await f.call('rep', 'POST', `/v1/imports/${job.id}/start`)).statusCode).toBe(409);
    await runImport(deps(), job.id);
    const done = json(await f.call('rep', 'GET', `/v1/imports/${job.id}`));
    expect(done).toMatchObject({
      status: 'COMPLETED',
      created: 2,
      skipped: 1,
      failed: 1,
      hasResults: true,
      undoableUntil: expect.any(String) as unknown,
    });
    const failed = json(await f.call('rep', 'GET', `/v1/imports/${job.id}/rows?status=FAILED`));
    expect(failed).toEqual({
      items: [
        {
          row: 3,
          status: 'FAILED',
          recordId: null,
          errors: [{ field: 'annual_revenue', code: 'invalid_number' }],
        },
      ],
      next: null,
    });
    const paged = json(await f.call('rep', 'GET', `/v1/imports/${job.id}/rows?limit=1`));
    expect(paged['next']).toBe(2);
    const results = await f.call('rep', 'GET', `/v1/imports/${job.id}/results`);
    expect(results.statusCode, results.body).toBe(200);
    expect(json(results)['url']).toContain('https://storage.fake/download/');
    const ada = await f.inTenant((tx) =>
      tx.kysely
        .selectFrom('lead' as never)
        .select(['annual_revenue', 'lead_source', 'deleted_at'] as never[])
        .where('email' as never, '=', 'ada@imports.test' as never)
        .executeTakeFirst(),
    );
    expect(ada).toMatchObject({ lead_source: 'web', deleted_at: null });

    // History, newest first.
    const history = json(await f.call('rep', 'GET', '/v1/imports?mine=true'));
    expect((history['items'] as Json[])[0]).toMatchObject({ id: job.id, status: 'COMPLETED' });

    // Undo: the records it created go to the recycle bin.
    const undo = await f.call('rep', 'POST', `/v1/imports/${job.id}/undo`);
    expect(undo.statusCode, undo.body).toBe(202);
    expect(json(undo)['status']).toBe('UNDOING');
    expect((await f.call('rep', 'POST', `/v1/imports/${job.id}/undo`)).statusCode).toBe(409);
    expect(await undoImport(deps(), job.id)).toEqual({ deleted: 2, kept: 0 });
    expect(json(await f.call('rep', 'GET', `/v1/imports/${job.id}`))).toMatchObject({
      status: 'UNDONE',
      undoneAt: expect.any(String) as unknown,
      undoableUntil: null,
    });
  });

  it('suggests the mapping used last time for the same headers', async () => {
    const job = await upload();
    await job.put();
    const analysis = json(await f.call('rep', 'POST', `/v1/imports/${job.id}/analyse`, {}));
    // The completed import above mapped these headers; its mapping comes back as is.
    expect(analysis['suggestions']).toHaveLength(5);
    const cancelled = await f.call('rep', 'POST', `/v1/imports/${job.id}/cancel`);
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(json(cancelled)['status']).toBe('CANCELLED');
    expect((await f.call('rep', 'POST', `/v1/imports/${job.id}/cancel`)).statusCode).toBe(409);
    expect((await f.call('rep', 'POST', `/v1/imports/${job.id}/start`)).statusCode).toBe(409);
  });

  it('refuses mappings it cannot run, files it cannot read and files too large', async () => {
    const job = await upload();
    await job.put();
    const { job: analysed } = json(
      await f.call('rep', 'POST', `/v1/imports/${job.id}/analyse`, {}),
    ) as { job: { version: number } };
    const patch = (payload: Json) =>
      f.call('rep', 'PATCH', `/v1/imports/${job.id}`, { version: analysed.version, ...payload });
    expect(firstError(await patch({ mapping: [{ column: 9, field: 'email' }] }))).toMatchObject({
      field: 'mapping.0.column',
      code: 'out_of_range',
    });
    expect(firstError(await patch({ mapping: [{ column: 0, field: 'score' }] }))).toMatchObject({
      field: 'mapping.0.field',
      code: 'not_editable',
    });
    expect(
      firstError(
        await patch({
          mapping: [
            { column: 0, field: 'email' },
            { column: 1, field: 'email' },
          ],
        }),
      ),
    ).toMatchObject({ field: 'mapping.1.field', code: 'duplicate' });
    expect(
      firstError(await patch({ mapping: [{ column: 0, field: 'email', dateOrder: 'DMY' }] })),
    ).toMatchObject({ field: 'mapping.0.dateOrder', code: 'not_applicable' });
    expect(firstError(await patch({ defaults: { nope: 'x' } }))).toMatchObject({
      field: 'defaults.nope',
    });
    expect(
      firstError(await patch({ matchingRuleId: '01920000-0000-7000-8000-000000000000' })),
    ).toMatchObject({ field: 'matchingRuleId', code: 'invalid_reference' });
    // Unmapped jobs cannot be run.
    expect(firstError(await f.call('rep', 'POST', `/v1/imports/${job.id}/start`))).toMatchObject({
      field: 'mapping',
    });

    const bad = await upload('rep', 'not a zip', 'leads.xlsx');
    await bad.put();
    expect(
      firstError(await f.call('rep', 'POST', `/v1/imports/${bad.id}/analyse`, {})),
    ).toMatchObject({
      field: 'file',
      code: 'unreadable_file',
    });
    const empty = await upload('rep', '\n\n');
    await empty.put();
    expect((await f.call('rep', 'POST', `/v1/imports/${empty.id}/analyse`, {})).statusCode).toBe(
      400,
    );
    const big = await f.call('rep', 'POST', '/v1/imports', {
      object: 'lead',
      fileName: 'big.xlsx',
      fileType: 'xlsx',
      fileSize: 200 * 1024 * 1024,
    });
    expect(firstError(big)).toMatchObject({ field: 'fileSize' });
  });

  it('answers 503 without object storage', () => {
    let thrown: unknown;
    try {
      new ImportsService(null).requireStorage();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    expect((thrown as DomainError).status).toBe(503);
  });
});

describe('who may import', () => {
  it('needs import_records, keeps jobs to their owner and tenant', async () => {
    const job = await upload();
    // No import_records: 403, even with view_setup.
    for (const user of ['viewer', 'peer'])
      expect((await f.call(user, 'GET', '/v1/imports')).statusCode, user).toBe(403);
    expect(
      (
        await f.call('peer', 'POST', '/v1/imports', {
          object: 'lead',
          fileName: 'x.csv',
          fileType: 'csv',
          fileSize: 10,
        })
      ).statusCode,
    ).toBe(403);
    // The admin (view_setup + import_records) reads everyone's imports but changes none.
    expect((await f.call('admin', 'GET', `/v1/imports/${job.id}`)).statusCode).toBe(200);
    const everyone = json(await f.call('admin', 'GET', '/v1/imports'));
    expect((everyone['items'] as Json[]).some((j) => j['id'] === job.id)).toBe(true);
    expect((await f.call('admin', 'POST', `/v1/imports/${job.id}/cancel`)).statusCode).toBe(403);
    const mine = json(await f.call('admin', 'GET', '/v1/imports?mine=true'));
    expect((mine['items'] as Json[]).some((j) => j['id'] === job.id)).toBe(false);
    // Another workspace never sees it.
    expect((await f.call('outsider', 'GET', `/v1/imports/${job.id}`)).statusCode).toBe(404);
    expect((await f.call('outsider', 'POST', `/v1/imports/${job.id}/start`)).statusCode).toBe(404);
    expect((await f.call('rep', 'GET', '/v1/imports/not-a-uuid')).statusCode).toBe(400);
    // Objects the caller cannot create into, or cannot see.
    const into = (object: string) =>
      f.call('rep', 'POST', '/v1/imports', {
        object,
        fileName: 'x.csv',
        fileType: 'csv',
        fileSize: 10,
      });
    expect((await into('campaign')).statusCode).toBe(403);
    expect((await into('nope')).statusCode).toBe(404);
  });
});

describe('mapping templates', () => {
  it('saves, offers for the same headers, lists and deletes', async () => {
    const headers = ['First Name', 'Last Name', 'Company', 'Email', 'Annual Revenue'];
    const create = (payload: Json = {}) =>
      f.call('rep', 'POST', '/v1/import-templates', {
        object: 'lead',
        name: 'CRM export',
        headers,
        mapping: [
          { column: 1, field: 'last_name' },
          { column: 2, field: 'company' },
        ],
        ...payload,
      });
    const created = await create();
    expect(created.statusCode, created.body).toBe(201);
    expect((await create()).statusCode).toBe(409);
    expect(
      firstError(await create({ name: 'Bad', mapping: [{ column: 7, field: 'company' }] })),
    ).toMatchObject({ code: 'out_of_range' });
    const id = json(created)['id'] as string;

    const job = await upload();
    await job.put();
    const analysis = json(await f.call('rep', 'POST', `/v1/imports/${job.id}/analyse`, {}));
    expect(analysis['templates']).toEqual([{ id, name: 'CRM export' }]);

    const list = json(await f.call('rep', 'GET', '/v1/import-templates?object=lead'));
    expect(list['items']).toEqual([expect.objectContaining({ id, name: 'CRM export' })]);
    expect((await f.call('viewer', 'GET', '/v1/import-templates')).statusCode).toBe(403);
    expect((await f.call('outsider', 'DELETE', `/v1/import-templates/${id}`)).statusCode).toBe(404);
    expect((await f.call('rep', 'DELETE', `/v1/import-templates/${id}`)).statusCode).toBe(204);
    expect((await f.call('rep', 'DELETE', `/v1/import-templates/${id}`)).statusCode).toBe(404);
  });
});
