import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createFastifyApp, createLogger, errors, requestContext, ZodPipe } from '../src/index.js';

const Signup = z.object({ email: z.email(), seats: z.number().int().positive() });

@Controller()
class TestController {
  @Get('ok')
  ok() {
    requestContext.countDbStatement();
    return { ok: true, requestId: requestContext.get()?.requestId };
  }

  @Get('missing')
  missing() {
    throw errors.notFound('Widget');
  }

  @Post('signup')
  signup(@Body(new ZodPipe(Signup)) body: z.infer<typeof Signup>) {
    return body;
  }

  @Get('boom')
  boom() {
    throw new Error('database password is hunter2');
  }
}

@Module({ controllers: [TestController] })
class TestModule {}

let app: NestFastifyApplication;
const logLines: Record<string, unknown>[] = [];

beforeAll(async () => {
  const destination = new Writable({
    write(chunk: Buffer, _enc, cb) {
      logLines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      cb();
    },
  });
  app = await createFastifyApp(TestModule, {
    logger: createLogger({ service: 'test', destination }),
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
});

describe('createFastifyApp request pipeline (§3.6)', () => {
  it('generates a UUIDv7 request id, echoes it, and exposes it in the request context', async () => {
    const res = await app.inject({ method: 'GET', url: '/ok' });
    const id = res.headers['x-request-id'];
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(res.json()).toEqual({ ok: true, requestId: id });
  });

  it('keeps a well-formed inbound x-request-id and replaces a malicious one', async () => {
    const kept = await app.inject({
      method: 'GET',
      url: '/ok',
      headers: { 'x-request-id': 'edge-abc12345' },
    });
    expect(kept.headers['x-request-id']).toBe('edge-abc12345');
    const replaced = await app.inject({
      method: 'GET',
      url: '/ok',
      headers: { 'x-request-id': 'x\r\nSet-Cookie: a=b' },
    });
    expect(replaced.headers['x-request-id']).not.toContain('Set-Cookie');
  });

  it('logs one access line with route, status and db statement count', async () => {
    logLines.length = 0;
    await app.inject({ method: 'GET', url: '/ok' });
    expect(logLines.find((l) => l['msg'] === 'request completed')).toMatchObject({
      method: 'GET',
      route: '/ok',
      status: 200,
      dbStatements: 1,
    });
  });
});

describe('ProblemDetailsFilter (RFC 9457)', () => {
  it('renders domain errors as problem+json with the request id as traceId', async () => {
    const res = await app.inject({ method: 'GET', url: '/missing' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toEqual({
      type: 'https://developers.salesmaker.app/problems/not-found',
      title: 'Not found',
      status: 404,
      code: 'not_found',
      detail: 'Widget not found',
      instance: '/missing',
      traceId: res.headers['x-request-id'],
    });
  });

  it('turns zod failures into 400 with field-keyed errors', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/signup',
      payload: { email: 'nope', seats: 0 },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ code: string; errors: { field: string }[] }>();
    expect(body.code).toBe('validation_failed');
    expect(body.errors.map((e) => e.field).sort()).toEqual(['email', 'seats']);
  });

  it('answers unknown routes with a 404 problem', async () => {
    const res = await app.inject({ method: 'GET', url: '/nowhere' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'not_found', status: 404 });
  });

  it('rejects malformed JSON as a 400 problem', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/signup',
      headers: { 'content-type': 'application/json' },
      payload: '{"email":',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'validation_failed' });
  });

  it('hides unexpected error details from the caller', async () => {
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('hunter2');
    expect(res.json()).toMatchObject({ code: 'internal_error', status: 500 });
  });
});
