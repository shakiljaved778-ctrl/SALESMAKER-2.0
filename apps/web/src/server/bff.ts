import {
  AcceptInvitationRequest,
  EmailRequest,
  LoginRequest,
  LoginResponse,
  MeResponse,
  MfaChallengeRequest,
  PreferencesPatch,
  ProblemDetails,
  ResetPasswordRequest,
  SessionTokens,
  TokenRequest,
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

export type Handler = (request: Request, deps: BffDeps) => Promise<Response>;

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

export type CellMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface CellResult {
  status: number;
  body: unknown;
  headers: Headers;
}

/**
 * One request to a cell API. The base URL always comes from the control plane (the directory or
 * the cell list), never from configuration (§3.4). Returns null when the cell is unreachable.
 */
export async function cellRequest(
  deps: Pick<BffDeps, 'fetch'>,
  baseUrl: string,
  path: string,
  init: {
    method?: CellMethod;
    body?: unknown;
    headers?: Record<string, string>;
    request?: Request;
  },
): Promise<CellResult | null> {
  const headers: Record<string, string> = { accept: 'application/json', ...init.headers };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const requestId = init.request?.headers.get('x-request-id');
  if (requestId) headers['x-request-id'] = requestId;
  try {
    const response = await (deps.fetch ?? fetch)(new URL(path, baseUrl), {
      method: init.method ?? 'POST',
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
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

/** POST to the tenant's cell, naming the workspace by header. */
export function callCell(
  deps: BffDeps,
  tenant: Tenant,
  path: string,
  body: unknown,
  request: Request,
): Promise<CellResult | null> {
  return cellRequest(deps, tenant.cell.apiBaseUrl, path, {
    body,
    headers: { 'x-sm-tenant-id': tenant.tenantId },
    request,
  });
}

export function unavailable(): Response {
  return problem(
    503,
    'service_unavailable',
    'SalesMaker is briefly unavailable',
    'Try again in a moment.',
  );
}

/** Relay a cell problem (status, body, Retry-After) or fail closed if it isn't one. */
export function relayProblem(
  result: CellResult,
  extraHeaders: Record<string, string> = {},
): Response {
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

export async function readJson<T extends z.ZodType>(request: Request, schema: T) {
  const body: unknown = await request.json().catch(() => undefined);
  return schema.safeParse(body);
}

export function invalid(error: z.ZodError): Response {
  return problem(
    422,
    'validation_failed',
    'Check the highlighted fields',
    undefined,
    error.issues.map((i) => ({ field: i.path.join('.'), code: i.code, message: i.message })),
  );
}

/** Tokens from the cell become: refresh token → cookie, access token → page memory. */
export function signedIn(
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

export function withTenantAndOrigin(
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
export function loginOutcome(deps: BffDeps, result: CellResult): Response {
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

/**
 * New access token from the refresh cookie (rotating it), plus the current user so a freshly
 * loaded page can render without its own call. The page keeps the access token in memory.
 */
export const refresh: Handler = withTenantAndOrigin(async (request, deps, tenant) => {
  const token = readCookie(request, refreshCookieName(deps.scheme));
  if (!token) return problem(401, 'unauthenticated', 'Sign in to continue');
  const result = await callCell(deps, tenant, '/auth/refresh', { refreshToken: token }, request);
  if (!result) return unavailable();
  if (result.status !== 200) {
    // A rejected refresh token (expired, revoked or reused) ends the browser session too.
    const clear: Record<string, string> =
      result.status === 401 || result.status === 404
        ? { 'set-cookie': clearRefreshCookie(deps.scheme) }
        : {};
    return relayProblem(result, clear);
  }
  const tokens = SessionTokens.safeParse(result.body);
  if (!tokens.success) return unavailable();
  const me = await cellRequest(deps, tenant.cell.apiBaseUrl, '/v1/me', {
    method: 'GET',
    headers: { authorization: `Bearer ${tokens.data.accessToken}` },
    request,
  });
  const user = me?.status === 200 ? MeResponse.safeParse(me.body) : undefined;
  // The rotated cookie must be stored even if the profile call failed, or the session is lost.
  return signedIn(deps, tokens.data, user?.success ? { user: user.data } : {});
});

/** Relay a tenant-scoped POST whose success carries no data the page needs. */
function relay(path: string, schema: z.ZodType): Handler {
  return withTenantAndOrigin(async (request, deps, tenant) => {
    const input = await readJson(request, schema);
    if (!input.success) return invalid(input.error);
    const result = await callCell(deps, tenant, path, input.data, request);
    if (!result) return unavailable();
    if (result.status >= 200 && result.status < 300) return json({ status: 'ok' });
    return relayProblem(result);
  });
}

export const verifyEmail = relay('/auth/verify-email', TokenRequest);
export const resendVerification = relay('/auth/verify-email/resend', EmailRequest);
export const forgotPassword = relay('/auth/password/forgot', EmailRequest);
export const resetPassword = relay('/auth/password/reset', ResetPasswordRequest);

export const logout: Handler = withTenantAndOrigin(async (request, deps, tenant) => {
  const token = readCookie(request, refreshCookieName(deps.scheme));
  // Best effort upstream: the cookie is cleared whatever the cell says.
  if (token) await callCell(deps, tenant, '/auth/logout', { refreshToken: token }, request);
  return new Response(null, {
    status: 204,
    headers: { 'set-cookie': clearRefreshCookie(deps.scheme), 'cache-control': 'no-store' },
  });
});

/**
 * Save display preferences to the profile (§9.6: persisted per user). The page's in-memory access
 * token authorises it; the cell enforces that the token belongs to this workspace.
 */
export const savePreferences: Handler = withTenantAndOrigin(async (request, deps, tenant) => {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return problem(401, 'unauthenticated', 'Sign in to continue');
  }
  const input = await readJson(request, PreferencesPatch);
  if (!input.success) return invalid(input.error);
  const result = await cellRequest(deps, tenant.cell.apiBaseUrl, '/v1/me/preferences', {
    method: 'PATCH',
    body: input.data,
    headers: { authorization },
    request,
  });
  if (!result) return unavailable();
  if (result.status !== 200) return relayProblem(result);
  const user = MeResponse.safeParse(result.body);
  return user.success ? json(user.data) : unavailable();
});

export const acceptInvitation: Handler = withTenantAndOrigin(async (request, deps, tenant) => {
  const input = await readJson(request, AcceptInvitationRequest);
  if (!input.success) return invalid(input.error);
  const result = await callCell(deps, tenant, '/auth/invitations/accept', input.data, request);
  return result ? loginOutcome(deps, result) : unavailable();
});

/**
 * Cell routes the page may reach through the relay: the signed-in `/v1` API, plus the two
 * signed-in TOTP enrolment steps (they predate `/v1`), nothing else.
 */
const RELAYABLE = /^\/v1\/[A-Za-z0-9_\-/.]*$/;
const RELAYABLE_WRITES = new Set(['/auth/mfa/totp/enroll', '/auth/mfa/totp/confirm']);

/**
 * The page's signed-in API (§3.1): `/api/v1/…` relays to the workspace's cell `/v1/…` with the
 * caller's bearer token, so the browser only ever talks to its own origin (CSP connect-src
 * 'self'). The token is held in page memory, never in a cookie, so another site cannot make the
 * browser send it; writes must also come from this origin. The cell decides everything else.
 */
export async function relayToCell(
  request: Request,
  deps: BffDeps,
  method: CellMethod,
): Promise<Response> {
  const writing = method !== 'GET';
  const origin = request.headers.get('origin');
  if ((writing || origin) && !isSameOrigin(request, deps.scheme)) {
    return problem(403, 'forbidden', 'Request refused', 'Cross-origin requests are not allowed.');
  }
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return problem(401, 'unauthenticated', 'Sign in to continue');
  }
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '');
  const allowed = RELAYABLE.test(path) || (method === 'POST' && RELAYABLE_WRITES.has(path));
  if (!allowed || path.split('/').some((s) => s === '..' || s === '.')) {
    return problem(404, 'not_found', 'Not found');
  }
  const resolved = await tenantFor(request, deps);
  if ('response' in resolved) return resolved.response;
  let body: unknown;
  if (writing && method !== 'DELETE') {
    const text = await request.text();
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        return problem(400, 'validation_failed', 'The request body is not JSON');
      }
    }
  }
  const headers: Record<string, string> = { authorization };
  const idempotencyKey = request.headers.get('idempotency-key');
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const result = await cellRequest(deps, resolved.tenant.cell.apiBaseUrl, `${path}${url.search}`, {
    method,
    ...(body === undefined ? {} : { body }),
    headers,
    request,
  });
  if (!result) return unavailable();
  if (result.status >= 400) return relayProblem(result);
  if (result.status === 204 || result.body === undefined) {
    return new Response(null, { status: result.status, headers: { 'cache-control': 'no-store' } });
  }
  return json(result.body, { status: result.status });
}
