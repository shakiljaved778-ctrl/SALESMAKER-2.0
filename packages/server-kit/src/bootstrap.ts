import 'reflect-metadata';

import type { IncomingMessage } from 'node:http';

import type { INestApplication, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Logger } from 'pino';
import { uuidv7 } from 'uuidv7';

import { PinoNestLogger } from './logger.js';
import { ProblemDetailsFilter } from './problem.js';
import { acceptRequestId, requestContext } from './request-context.js';
import { annotateActiveSpan } from './telemetry.js';

export interface CreateAppOptions {
  logger: Logger;
  /** Hook for extra Fastify setup (rate limiting, CORS) before routes are registered. */
  configure?: (app: NestFastifyApplication) => Promise<void> | void;
  bodyLimitBytes?: number;
}

/**
 * Build a NestJS app on Fastify with the SalesMaker request pipeline (§3.6):
 * request id (inbound x-request-id if sane, otherwise UUIDv7) → request context → routes →
 * RFC 9457 errors; one access log line and span attributes per request.
 */
export async function createFastifyApp(
  module: Type,
  options: CreateAppOptions,
): Promise<NestFastifyApplication> {
  const { logger } = options;
  const adapter = new FastifyAdapter({
    genReqId: (req: IncomingMessage) => acceptRequestId(req.headers['x-request-id']) ?? uuidv7(),
    bodyLimit: options.bodyLimitBytes ?? 1_048_576,
    trustProxy: true,
    logger: false,
  });
  const app = await NestFactory.create<NestFastifyApplication>(module, adapter, {
    logger: new PinoNestLogger(logger),
    bufferLogs: false,
  });

  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onRequest', (request, reply, done) => {
    requestContext.enter(request.id);
    void reply.header('x-request-id', request.id);
    done();
  });
  fastify.addHook('onResponse', (request, reply, done) => {
    const ctx = requestContext.get();
    const route = request.routeOptions.url ?? 'unmatched';
    annotateActiveSpan({
      route,
      'tenant.id': ctx?.tenantId ?? '',
      'user.id': ctx?.userId ?? '',
      'db.statement.count': ctx?.dbStatements ?? 0,
    });
    logger.info(
      {
        method: request.method,
        route,
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
        dbStatements: ctx?.dbStatements ?? 0,
      },
      'request completed',
    );
    done();
  });

  app.useGlobalFilters(new ProblemDetailsFilter(logger));
  app.enableShutdownHooks();
  await options.configure?.(app);
  return app;
}

export type { INestApplication };
