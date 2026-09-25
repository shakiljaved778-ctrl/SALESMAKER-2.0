import { readFileSync } from 'node:fs';

import { buildOpenApiDocument } from '@sm/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CONTROL_API_INFO, controlApiRoutes } from '../src/openapi/routes.js';
import { startTestControlApi, type TestControlApi } from './support.js';

let cp: TestControlApi;

beforeAll(async () => {
  cp = await startTestControlApi();
});

afterAll(async () => {
  await cp.dispose();
});

describe('control-plane contracts', () => {
  it('has a contract for every served route, and vice versa', () => {
    const served = cp.servedRoutes
      .map((r) => {
        const [method = '', url = ''] = r.split(' ');
        return `${method.toLowerCase()} ${url.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`;
      })
      .sort();
    expect(served).toEqual(controlApiRoutes.map((r) => `${r.method} ${r.path}`).sort());
  });

  it('matches the committed openapi.snapshot.json', () => {
    const committed = readFileSync(new URL('../openapi.snapshot.json', import.meta.url), 'utf8');
    expect(
      `${JSON.stringify(buildOpenApiDocument(controlApiRoutes, CONTROL_API_INFO), null, 2)}\n`,
    ).toBe(committed);
  });
});
