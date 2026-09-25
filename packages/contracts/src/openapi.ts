import { z } from 'zod';

import { ProblemDetails } from './problem.js';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** Who may call a route. Every route declares it; "public" routes are few and deliberate. */
export type RouteAuth = 'public' | 'session' | 'service';

export interface RouteContract {
  method: HttpMethod;
  /** OpenAPI path template, e.g. `/v1/records/{object}/{id}`. */
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  auth: RouteAuth;
  /** Internal routes (§10.2) are never exposed to API keys or published in the public docs. */
  visibility: 'public-api' | 'internal';
  request?: {
    params?: z.ZodObject;
    query?: z.ZodObject;
    headers?: z.ZodObject;
    body?: z.ZodType;
  };
  responses: Record<number, { description: string; body?: z.ZodType }>;
}

/** Declare a route contract. A no-op at runtime that keeps the literal types intact. */
export function defineRoute<const R extends RouteContract>(route: R): R {
  return route;
}

type JsonSchema = Record<string, unknown>;

const DEFAULT_ERRORS: Record<number, string> = {
  400: 'Validation failed',
  401: 'Not authenticated',
  404: 'Not found (also returned for resources in another tenant, so existence is not leaked)',
  429: 'Rate limited',
  500: 'Internal error',
};

function toSchema(
  schema: z.ZodType,
  io: 'input' | 'output',
  components: Record<string, JsonSchema>,
): JsonSchema {
  const generated = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'any',
    metadata: z.globalRegistry,
  });
  // Named schemas (`.meta({ id })`) land in $defs; OpenAPI keeps them under components.
  const json = JSON.parse(
    JSON.stringify(generated).replaceAll('"#/$defs/', '"#/components/schemas/'),
  ) as JsonSchema & { $defs?: Record<string, JsonSchema>; $schema?: string; id?: string };
  const { $defs, id, ...rest } = json;
  delete rest.$schema;
  for (const [name, def] of Object.entries($defs ?? {})) components[name] = def;
  // A top-level named schema is itself moved to components and referenced.
  if (typeof id === 'string') {
    components[id] = rest;
    return { $ref: `#/components/schemas/${id}` };
  }
  return rest;
}

function parameters(
  location: 'path' | 'query' | 'header',
  obj: z.ZodObject | undefined,
  components: Record<string, JsonSchema>,
) {
  if (!obj) return [];
  type ObjectSchema = {
    $ref?: string;
    properties?: Record<string, JsonSchema>;
    required?: string[];
  };
  let schema = toSchema(obj, 'input', components) as ObjectSchema;
  // Named objects (e.g. PageQuery) come back as a $ref; parameters need their properties inline.
  if (schema.$ref) schema = components[schema.$ref.split('/').pop() ?? ''] ?? {};
  return Object.entries(schema.properties ?? {}).map(([name, s]) => ({
    name,
    in: location,
    required: location === 'path' || (schema.required ?? []).includes(name),
    schema: s,
  }));
}

export interface OpenApiInfo {
  title: string;
  version: string;
  description?: string;
  servers?: { url: string; description?: string }[];
}

/**
 * Build an OpenAPI 3.1 document from route contracts (§10.1). The output is deterministic
 * (sorted paths, stable component names) so it can be committed as a snapshot and diffed in
 * CI (contract drift check).
 */
export function buildOpenApiDocument(
  routes: readonly RouteContract[],
  info: OpenApiInfo,
): JsonSchema {
  const components: Record<string, JsonSchema> = {};
  const paths: Record<string, Record<string, JsonSchema>> = {};
  const problem = toSchema(ProblemDetails, 'output', components);

  const sorted = [...routes].sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );
  for (const route of sorted) {
    const operation: JsonSchema = {
      operationId: route.operationId,
      summary: route.summary,
      tags: route.tags,
      'x-sm-visibility': route.visibility,
      parameters: [
        ...parameters('path', route.request?.params, components),
        ...parameters('query', route.request?.query, components),
        ...parameters('header', route.request?.headers, components),
      ],
      responses: {},
    };
    if (route.description) operation['description'] = route.description;
    if (route.auth !== 'public')
      operation['security'] = [{ [route.auth === 'service' ? 'serviceToken' : 'bearerAuth']: [] }];
    if (route.request?.body) {
      operation['requestBody'] = {
        required: true,
        content: {
          'application/json': { schema: toSchema(route.request.body, 'input', components) },
        },
      };
    }
    const responses: Record<string, JsonSchema> = {};
    for (const [status, res] of Object.entries(route.responses)) {
      responses[status] = res.body
        ? {
            description: res.description,
            content: { 'application/json': { schema: toSchema(res.body, 'output', components) } },
          }
        : { description: res.description };
    }
    const errorStatuses = { ...DEFAULT_ERRORS };
    if (route.auth === 'public') delete errorStatuses[401];
    for (const [status, description] of Object.entries(errorStatuses)) {
      responses[status] ??= {
        description,
        content: { 'application/problem+json': { schema: problem } },
      };
    }
    operation['responses'] = responses;
    paths[route.path] = { ...(paths[route.path] ?? {}), [route.method]: operation };
  }

  const sortedComponents = Object.fromEntries(
    Object.entries(components).sort(([a], [b]) => a.localeCompare(b)),
  );
  return {
    openapi: '3.1.0',
    info,
    ...(info.servers ? { servers: info.servers } : {}),
    paths,
    components: {
      schemas: sortedComponents,
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        serviceToken: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Cell ↔ control-plane service token',
        },
      },
    },
  };
}
