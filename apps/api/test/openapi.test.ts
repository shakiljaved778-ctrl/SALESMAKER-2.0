import { readFileSync } from 'node:fs';

import { buildOpenApiDocument } from '@sm/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_INFO, apiRoutes } from '../src/openapi/routes.js';
import { startTestApi, type TestApi } from './support.js';

let api: TestApi;

beforeAll(async () => {
  api = await startTestApi();
});

afterAll(async () => {
  await api.dispose();
});

const toOpenApiPath = (fastifyUrl: string) => fastifyUrl.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

describe('contracts (golden rule 7, §10.1)', () => {
  it('has a contract for every route the API serves, and vice versa', () => {
    const served = api.servedRoutes
      .map((r) => {
        const [method = '', url = ''] = r.split(' ');
        return `${method.toLowerCase()} ${toOpenApiPath(url)}`;
      })
      .sort();
    const contracted = apiRoutes.map((r) => `${r.method} ${r.path}`).sort();
    expect(served).toEqual(contracted);
  });

  it('matches the committed openapi.snapshot.json (drift check; run `pnpm openapi:write` after changing contracts)', () => {
    const committed = readFileSync(new URL('../openapi.snapshot.json', import.meta.url), 'utf8');
    expect(`${JSON.stringify(buildOpenApiDocument(apiRoutes, API_INFO), null, 2)}\n`).toBe(
      committed,
    );
  });

  it('serves only public-api routes at /v1/openapi.json', async () => {
    const res = await api.app.inject({ method: 'GET', url: '/v1/openapi.json' });
    const doc = res.json<{ openapi: string; paths: Record<string, unknown> }>();
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(['/v1/openapi.json']);
  });
});
