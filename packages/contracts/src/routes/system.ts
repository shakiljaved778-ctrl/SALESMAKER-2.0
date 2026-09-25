import { z } from 'zod';

import { defineRoute } from '../openapi.js';

export const HealthResponse = z
  .object({ status: z.literal('ok'), service: z.string(), cell: z.string() })
  .meta({ id: 'HealthResponse' });

export const ReadinessResponse = z
  .object({
    status: z.enum(['ready', 'degraded']),
    checks: z.record(z.string(), z.enum(['ok', 'failing'])),
  })
  .meta({ id: 'ReadinessResponse' });

/** Liveness and readiness probes shared by every service (ALB and ECS health checks). */
export const systemRoutes = {
  health: defineRoute({
    method: 'get',
    path: '/health',
    operationId: 'getHealth',
    summary: 'Liveness probe',
    tags: ['system'],
    auth: 'public',
    visibility: 'internal',
    responses: { 200: { description: 'The process is up', body: HealthResponse } },
  }),
  ready: defineRoute({
    method: 'get',
    path: '/health/ready',
    operationId: 'getReadiness',
    summary: 'Readiness probe: database and cache reachable',
    tags: ['system'],
    auth: 'public',
    visibility: 'internal',
    responses: {
      200: { description: 'Ready to serve traffic', body: ReadinessResponse },
      503: { description: 'A dependency is failing', body: ReadinessResponse },
    },
  }),
};

export const openApiRoute = defineRoute({
  method: 'get',
  path: '/v1/openapi.json',
  operationId: 'getOpenApiDocument',
  summary: 'This API’s OpenAPI 3.1 document (public routes only)',
  tags: ['system'],
  auth: 'public',
  visibility: 'public-api',
  responses: {
    200: { description: 'OpenAPI 3.1 document', body: z.record(z.string(), z.unknown()) },
  },
});
