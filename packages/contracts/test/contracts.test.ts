import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import {
  BusinessDate,
  buildOpenApiDocument,
  cursorPage,
  defineRoute,
  Money,
  PageQuery,
  problemType,
  TenantSlug,
  Timestamp,
  Uuid,
} from '../src/index.js';

describe('primitives', () => {
  it('accepts only UUIDv7 ids', () => {
    expect(Uuid.safeParse('01920000-0000-7000-8000-000000000001').success).toBe(true);
    expect(Uuid.safeParse('2f1b4c7e-9d1a-4c1e-8f3a-5b6c7d8e9f00').success).toBe(false); // v4
    expect(Uuid.safeParse('not-a-uuid').success).toBe(false);
  });

  it('keeps money as a string decimal with at most two fraction digits (golden rule 8)', () => {
    expect(Money.safeParse({ amount: '1250.00', currency: 'USD' }).success).toBe(true);
    expect(Money.safeParse({ amount: '-0.5', currency: 'QAR' }).success).toBe(true);
    expect(Money.safeParse({ amount: '9999999999999999.99', currency: 'EUR' }).success).toBe(true);
    expect(Money.safeParse({ amount: '10000000000000000.00', currency: 'EUR' }).success).toBe(
      false,
    );
    expect(Money.safeParse({ amount: 1250, currency: 'USD' }).success).toBe(false);
    expect(Money.safeParse({ amount: '1.005', currency: 'USD' }).success).toBe(false);
    expect(Money.safeParse({ amount: '01.00', currency: 'USD' }).success).toBe(false);
    expect(Money.safeParse({ amount: '1.00', currency: 'usd' }).success).toBe(false);
  });

  it('requires UTC timestamps and plain business dates', () => {
    expect(Timestamp.safeParse('2026-09-25T09:30:00Z').success).toBe(true);
    expect(Timestamp.safeParse('2026-09-25T09:30:00+03:00').success).toBe(false);
    expect(BusinessDate.safeParse('2026-10-12').success).toBe(true);
    expect(BusinessDate.safeParse('2026-10-12T00:00:00Z').success).toBe(false);
  });

  it('validates tenant slugs', () => {
    for (const ok of ['pixelcraft', 'aurelia-bank', 'a1b'])
      expect(TenantSlug.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['ab', 'Aurelia', '-lead', 'trail-', 'double--hyphen', 'x'.repeat(41)]) {
      expect(TenantSlug.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('caps page size at 200 and coerces query strings', () => {
    expect(PageQuery.parse({ limit: '25' })).toEqual({ limit: 25 });
    expect(PageQuery.parse({})).toEqual({ limit: 50 });
    expect(PageQuery.safeParse({ limit: '201' }).success).toBe(false);
  });

  it('builds problem type URIs', () => {
    expect(problemType('version_conflict')).toBe(
      'https://developers.salesmaker.app/problems/version-conflict',
    );
  });
});

describe('buildOpenApiDocument', () => {
  const Widget = z.object({ id: Uuid, price: Money, createdAt: Timestamp }).meta({ id: 'Widget' });
  const routes = [
    defineRoute({
      method: 'get',
      path: '/v1/widgets/{id}',
      operationId: 'getWidget',
      summary: 'Get a widget',
      tags: ['widgets'],
      auth: 'session',
      visibility: 'public-api',
      request: { params: z.object({ id: Uuid }) },
      responses: { 200: { description: 'The widget', body: Widget } },
    }),
    defineRoute({
      method: 'get',
      path: '/v1/widgets',
      operationId: 'listWidgets',
      summary: 'List widgets',
      tags: ['widgets'],
      auth: 'session',
      visibility: 'public-api',
      request: { query: PageQuery },
      responses: { 200: { description: 'A page', body: cursorPage(Widget) } },
    }),
    defineRoute({
      method: 'get',
      path: '/health',
      operationId: 'health',
      summary: 'Health',
      tags: ['system'],
      auth: 'public',
      visibility: 'internal',
      responses: { 200: { description: 'OK' } },
    }),
  ];
  const doc = buildOpenApiDocument(routes, { title: 'Test', version: '1' });

  it('emits OpenAPI 3.1 with shared component schemas', () => {
    expect(doc['openapi']).toBe('3.1.0');
    const schemas = (doc['components'] as { schemas: Record<string, unknown> }).schemas;
    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining(['CurrencyCode', 'Money', 'ProblemDetails', 'Uuid', 'Widget']),
    );
  });

  it('adds security to non-public routes and problem+json error responses', () => {
    const paths = doc['paths'] as Record<
      string,
      Record<string, { security?: unknown; responses: Record<string, unknown> }>
    >;
    const getWidget = paths['/v1/widgets/{id}']?.['get'];
    expect(getWidget?.security).toEqual([{ bearerAuth: [] }]);
    expect(Object.keys(getWidget?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '400', '401', '404', '429', '500']),
    );
    const health = paths['/health']?.['get'];
    expect(health?.security).toBeUndefined();
    expect(Object.keys(health?.responses ?? {})).not.toContain('401');
  });

  it('turns params and query objects into OpenAPI parameters', () => {
    const paths = doc['paths'] as Record<
      string,
      Record<string, { parameters: { name: string; in: string; required: boolean }[] }>
    >;
    expect(paths['/v1/widgets/{id}']?.['get']?.parameters).toEqual([
      expect.objectContaining({ name: 'id', in: 'path', required: true }),
    ]);
    expect(
      paths['/v1/widgets']?.['get']?.parameters.map((p) => [p.name, p.in, p.required]),
    ).toEqual([
      ['limit', 'query', false],
      ['cursor', 'query', false],
    ]);
  });

  it('only emits $refs that resolve to a component', () => {
    const text = JSON.stringify(doc);
    const refs = [...text.matchAll(/"\$ref":"([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(refs.length).toBeGreaterThan(0);
    const schemas = (doc['components'] as { schemas: Record<string, unknown> }).schemas;
    for (const ref of refs) {
      expect(ref).toMatch(/^#\/components\/schemas\//);
      expect(schemas[ref.replace('#/components/schemas/', '')], ref).toBeDefined();
    }
  });

  it('is deterministic, so it can be snapshotted for the drift check', () => {
    const again = buildOpenApiDocument([...routes].reverse(), { title: 'Test', version: '1' });
    expect(JSON.stringify(again)).toBe(JSON.stringify(doc));
  });
});
