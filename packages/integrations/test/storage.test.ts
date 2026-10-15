import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Readable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeStorageProvider, S3StorageProvider, s3StorageFrom, storageKey } from '../src/index.js';

const text = async (stream: Readable) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
};

/** A minimal S3-compatible store (path-style PUT, GET, DELETE) on localhost: no third party. */
let server: Server;
let endpoint = '';
const stored = new Map<string, Buffer>();
beforeAll(async () => {
  server = createServer((req, res) => {
    const key = decodeURIComponent((req.url ?? '').split('?')[0] ?? '');
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        stored.set(key, Buffer.concat(chunks));
        res.writeHead(200, { etag: '"x"' }).end();
      });
      return;
    }
    if (req.method === 'GET') {
      const body = stored.get(key);
      if (!body) {
        res
          .writeHead(404, { 'content-type': 'application/xml' })
          .end('<Error><Code>NoSuchKey</Code></Error>');
        return;
      }
      res
        .writeHead(200, { 'content-length': String(body.length), 'content-type': 'text/csv' })
        .end(body);
      return;
    }
    if (req.method === 'DELETE') {
      stored.delete(key);
      res.writeHead(204).end();
      return;
    }
    res.writeHead(405).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
});

describe('storage (§3.12)', () => {
  it('keys objects by tenant and month', () => {
    expect(storageKey('t-1', 'id-1', new Date('2026-03-05T00:00:00Z'))).toBe('t-1/2026/03/id-1');
  });

  it('S3: writes, reads and deletes objects, and signs URLs', async () => {
    const s3 = new S3StorageProvider({
      endpoint,
      region: 'eu-central-1',
      bucket: 'files',
      accessKeyId: 'test',
      secretAccessKey: 'test-secret',
    });
    await s3.putObject('t/2026/10/a.csv', Buffer.from('name\nAcme\n'), 'text/csv');
    expect(stored.has('/files/t/2026/10/a.csv')).toBe(true);
    expect(await text(await s3.getObject('t/2026/10/a.csv'))).toBe('name\nAcme\n');
    await s3.delete('t/2026/10/a.csv');
    await expect(s3.getObject('t/2026/10/a.csv')).rejects.toThrow();
    const put = new URL(await s3.presignPut('t/k', 'text/csv', 1024, 300));
    expect(put.pathname).toBe('/files/t/k');
    expect(put.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(put.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(new URL(await s3.presignGet('t/k', 60)).searchParams.get('X-Amz-Expires')).toBe('60');
  });

  it('S3 from config: on with a bucket; static keys optional (the task role in cells)', () => {
    expect(s3StorageFrom({ S3_REGION: 'eu-central-1' })).toBeUndefined();
    expect(s3StorageFrom({ S3_REGION: 'eu-central-1', S3_BUCKET: 'files' })).toBeInstanceOf(
      S3StorageProvider,
    );
    expect(
      s3StorageFrom({
        S3_REGION: 'eu-central-1',
        S3_BUCKET: 'files',
        S3_ACCESS_KEY_ID: 'a',
        S3_SECRET_ACCESS_KEY: 'b',
      }),
    ).toBeInstanceOf(S3StorageProvider);
  });

  it('fake: keeps bytes and URLs deterministic', async () => {
    const fake = new FakeStorageProvider();
    await fake.putObject('k', Buffer.from('hello'), 'text/plain');
    expect(await text(await fake.getObject('k'))).toBe('hello');
    expect(await fake.presignGet('k')).toBe('https://storage.fake/download/k');
    await fake.delete('k');
    await expect(fake.getObject('k')).rejects.toThrow('no object k');
  });
});
