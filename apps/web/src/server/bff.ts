import {
  LoginRequest,
  LoginResponse,
  MfaChallengeRequest,
  ProblemDetails,
  SessionTokens,
} from '@sm/contracts';
import type { z } from 'zod';

import { classifyHost } from './host';
import { isSameOrigin, json, problem, readCookie } from './http';
import { clearRefreshCookie, refreshCookieName, setRefreshCookie } from './session-cookie';
import { DirectoryUnavailableError, type Tenant, type TenantDirectory } from './tenant-directory';

export interface BffDeps {
  directory: Pick<TenantDirectory, 'resolve'>;
  baseDomain: string;
  scheme: 'http' | 'https';
  fetch?: typeof fetch;
  now?: () => number;
}

type Handler = (request: Request, deps: BffDeps) => Promise<Response>;

/** Resolve the workspace behind this request's host, or the response to send instead. */
export async function tenantFor(
  request: Request,
  deps: BffDeps,
): Promise<{ tenant: Tenant } | { response: Response }> {
  const host = classifyHost(request.headers.get('host'), deps.baseDomain);
  if (host.kind !== 'workspace') {
    return { response: problem(404, 'not_found', 'Workspace not found') };
  }
  try {
    const tenant = await deps.directory.resolve(host.host);
    if (!tenant) return { response: problem(404, 'not_found', 'Workspace not found') };
    return { tenant };
  } catch (err) {
    if (err instanceof DirectoryUnavailableError) {
      return {
        response: problem(
          503,
          'service_unavailable',
          'SalesMaker is briefly unavailable',
          'Try again in a moment.',
        ),
      };
    }
    throw err;
  }
}

interface CellResult {
  status: number;
  body: unknown;
  headers: Headers;
}

/** POST to the tenant's cell API. The base URL comes only from the directory (§3.4). */
async function callCell(
  deps: BffDeps,
  tenant: Tenant,
  path: string,
  body: unknown,
  request: Request,
): Promise<CellResult | null> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    'x-sm-tenant-id': tenant.tenantId,
  };
  const requestId = request.headers.get('x-request-id');
  if (requestId) headers['x-request-id'] = requestId;
  try {
    const response = await (deps.fetch ?? fetch)(new URL(path, tenant.cell.apiBaseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? (JSON.parse(text) as unknown) : undefined,
      headers: response.headers,
    };
  } catch {
    return null;
  }
}

function unavailable(): Response {
  return problem(
    503,
    'service_unavailable',
    'SalesMaker is briefly unavailable',
    'Try again in a moment.',
  );
}

/** Relay a cell problem (status, body, Retry-After) or fail closed if it isn't one. */
function relayProblem(result: CellResult, extraHeaders: Record<string, string> = {}): Response {
  const parsed = ProblemDetails.safeParse(result.body);
  if (!parsed.success) return unavailable();
  const headers: Record<string, string> = {
    'content-type': 'application/problem+json',
    'cache-control': 'no-store',
    ...extraHeaders,
  };
  const retryAfter = result.headers.get('retry-after');
  if (retryAfter) headers['retry-after'] = retryAfter;
  return Response.json(parsed.data, { status: result.status, headers });
}

async function readJson<T extends z.ZodType>(request: Request, schema: T) {
  const body: unknown = await request.json().catch(() => undefined);
  return schema.safeParse(body);
}

function invalid(error: z.ZodError): Response {
  return problem(
    422,
    'validation_failed',
    'Check the highlighted fields',
    undefined,
    error.issues.map((i) => ({ field: i.path.join('.'), code: i.code, message: i.message })),
  );
}

/** Tokens from the cell become: refresh token → cookie, access token → page memory. */
function signedIn(
  deps: BffDeps,
  tokens: z.infer<typeof SessionTokens>,
  extra: Record<string, unknown> = {},
): Response {
  return json(
    {
      status: 'ok',
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      ...extra,
    },
    {
      headers: {
        'set-cookie': setRefreshCookie(
          deps.scheme,
          tokens.refreshToken,
          tokens.refreshTokenExpiresAt,
          deps.now?.(),
        ),
      },
    },
  );
}

function withTenantAndOrigin(
  handler: (request: Request, deps: BffDeps, tenant: Tenant) => Promise<Response>,
): Handler {
  return async (request, deps) => {
    if (!isSameOrigin(request, deps.scheme)) {
      return problem(403, 'forbidden', 'Request refused', 'Cross-origin requests are not allowed.');
    }
    const resolved = await tenantFor(request, deps);
    if ('response' in resolved) return resolved.response;
    return handler(request, deps, resolved.tenant);
  };
}

/** Relay a login-shaped answer (ok → cookie; mfa_required → challenge token to the page). */
function loginOutcome(deps: BffDeps, result: CellResult): Response {
  if (result.status !== 200) return relayProblem(result);
  const parsed = LoginResponse.safeParse(result.body);
  if (!parsed.success) return unavailable();
  if (parsed.data.status === 'mfa_required') return json(parsed.data);
  return signedIn(deps, parsed.data.tokens, { user: parsed.data.user });
}

export const login: Handler = withTenantAndOrigin(async (request, deps, tenant) => {
  const input = await readJson(request, LoginRequest);
  if (!input.success) return invalid(input.error);
  const result = await callCell(deps, tenant, '/auth/login', input.data, request);
  return result ? loginOutcome(deps, result) : unavailable();
});

export const mfaChallenge: Handler = withTenantAndOrigin(async (request, deps, tenant) => {
  const input = await readJson(request, MfaChallengeRequest);
  if (!input.success) return invalid(input.error);
  const result = await callCell(deps, tenant, '/auth/mfa/challenge', input.data, request);
  return result ? loginOutcome(deps, result) : unavailable();
});

export const refresh: Handler = withTenantAndOrigin(async (request, deps, tenant) => {
  const token = readCookie(request, refreshCookieName(deps.scheme));
  if (!token) return problem(401, 'unauthenticated', 'Sign in to continue');
  const result = await callCell(deps, tenant, '/auth/refresh', { refreshToken: token }, request);
  if (!result) return unavailable();
  if (result.status === 200) {
    const tokens = SessionTokens.safeParse(result.body);
    return tokens.success ? signedIn(deps, tokens.data) : unavailable();
  }
  // A rejected refresh token (expired, revoked or reused) ends the browser session too.
  const clear: Record<string, string> =
    result.status === 401 || result.status === 404
      ? { 'set-cookie': clearRefreshCookie(deps.scheme) }
      : {};
  return relayProblem(result, clear);
});

export const logout: Handler = withTenantAndOrigin(async (request, deps, tenant) => {
  const token = readCookie(request, refreshCookieName(deps.scheme));
  // Best effort upstream: the cookie is cleared whatever the cell says.
  if (token) await callCell(deps, tenant, '/auth/logout', { refreshToken: token }, request);
  return new Response(null, {
    status: 204,
    headers: { 'set-cookie': clearRefreshCookie(deps.scheme), 'cache-control': 'no-store' },
  });
});
