import { LoginResponse, OidcSignupResponse, OidcStartResponse } from '@sm/contracts';
import { z } from 'zod';

import { IdempotencyKey, SignupForm, type ApexDeps } from './apex';
import { callCell, cellRequest, invalid, readJson, signedIn, tenantFor, type BffDeps } from './bff';
import { classifyHost, workspaceOrigin } from './host';
import { isSameOrigin, json, problem, readCookie } from './http';

export const PROVIDERS = ['google', 'microsoft'] as const;
export type Provider = (typeof PROVIDERS)[number];

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

/** PKCE and replay values for one sign-in attempt; server-set, httpOnly, ten minutes. */
const OidcState = z.object({
  provider: z.enum(PROVIDERS),
  redirectUri: z.url(),
  state: z.string(),
  nonce: z.string(),
  codeVerifier: z.string(),
  signup: SignupForm.omit({ name: true, email: true, password: true })
    .extend({ idempotencyKey: IdempotencyKey })
    .optional(),
});
type OidcState = z.infer<typeof OidcState>;

const STATE_MAX_AGE = 600;

function stateCookieName(scheme: 'http' | 'https') {
  return scheme === 'https' ? '__Host-sm_oidc' : 'sm_oidc';
}

/** Lax, because the IdP's redirect back is a cross-site top-level navigation. */
function setStateCookie(scheme: 'http' | 'https', value: OidcState): string {
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
  return [
    `${stateCookieName(scheme)}=${encoded}`,
    'Path=/',
    `Max-Age=${String(STATE_MAX_AGE)}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(scheme === 'https' ? ['Secure'] : []),
  ].join('; ');
}

function clearStateCookie(scheme: 'http' | 'https'): string {
  return [
    `${stateCookieName(scheme)}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
    ...(scheme === 'https' ? ['Secure'] : []),
  ].join('; ');
}

function readState(request: Request, scheme: 'http' | 'https'): OidcState | null {
  const raw = readCookie(request, stateCookieName(scheme));
  if (!raw) return null;
  try {
    const parsed = OidcState.safeParse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The URL the browser actually requested, rebuilt from the public host (never an internal one). */
function externalUrl(request: Request, scheme: 'http' | 'https'): string {
  const url = new URL(request.url);
  return `${scheme}://${request.headers.get('host') ?? url.host}${url.pathname}${url.search}`;
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status: 302, headers });
}

async function startAt(
  deps: BffDeps,
  baseUrl: string,
  provider: Provider,
  redirectUri: string,
  request: Request,
) {
  const result = await cellRequest(deps, baseUrl, `/auth/oidc/${provider}/start`, {
    body: { redirectUri },
    request,
  });
  if (result?.status !== 200) return null;
  const parsed = OidcStartResponse.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

// ── Workspace sign-in ──────────────────────────────────────────────────────────────────────

/** GET /auth/start/{provider}: remember the PKCE values and send the browser to the IdP. */
export async function startSignIn(request: Request, deps: BffDeps, provider: string) {
  if (!isProvider(provider)) return problem(404, 'not_found', 'Not found');
  const resolved = await tenantFor(request, deps);
  if ('response' in resolved) return resolved.response;
  const host = request.headers.get('host') ?? '';
  const redirectUri = `${deps.scheme}://${host}/auth/callback/${provider}`;
  const started = await startAt(
    deps,
    resolved.tenant.cell.apiBaseUrl,
    provider,
    redirectUri,
    request,
  );
  if (!started) return redirect(`/sso/${provider}?failed=1`);
  return redirect(started.authorizationUrl, [
    setStateCookie(deps.scheme, { provider, redirectUri, ...started }),
  ]);
}

/** GET /auth/callback/{provider}: finish at the cell; tokens become the session cookie. */
export async function completeSignIn(request: Request, deps: BffDeps, provider: string) {
  if (!isProvider(provider)) return problem(404, 'not_found', 'Not found');
  const resolved = await tenantFor(request, deps);
  if ('response' in resolved) return resolved.response;
  const saved = readState(request, deps.scheme);
  const clear = clearStateCookie(deps.scheme);
  const failed = (reason: string) => redirect(`/sso/${provider}?failed=${reason}`, [clear]);
  if (saved?.provider !== provider || saved.signup) return failed('1');

  const result = await callCell(
    deps,
    resolved.tenant,
    `/auth/oidc/${provider}/callback`,
    {
      callbackUrl: externalUrl(request, deps.scheme),
      redirectUri: saved.redirectUri,
      state: saved.state,
      nonce: saved.nonce,
      codeVerifier: saved.codeVerifier,
    },
    request,
  );
  if (result?.status === 403) return failed('no_account');
  if (result?.status !== 200) return failed('1');
  const login = LoginResponse.safeParse(result.body);
  if (!login.success) return failed('1');
  if (login.data.status === 'mfa_required') {
    // The fragment never reaches a server or a log; the sign-in page picks it up.
    return redirect(`/sign-in#mfa=${encodeURIComponent(login.data.mfaToken)}`, [clear]);
  }
  const session = signedIn(deps, login.data.tokens);
  return redirect('/', [clear, session.headers.get('set-cookie') ?? '']);
}

// ── Organisation sign-up with Google or Microsoft (apex) ─────────────────────────────────────

const OidcSignupStart = SignupForm.omit({ name: true, email: true, password: true }).extend({
  provider: z.enum(PROVIDERS),
});

/** POST /api/signup/oidc: organisation details now, identity from the provider next. */
export async function startSignup(request: Request, deps: ApexDeps): Promise<Response> {
  if (!isSameOrigin(request, deps.scheme)) {
    return problem(403, 'forbidden', 'Request refused', 'Cross-origin requests are not allowed.');
  }
  if (classifyHost(request.headers.get('host'), deps.baseDomain).kind !== 'apex') {
    return problem(404, 'not_found', 'Not found');
  }
  const key = IdempotencyKey.safeParse(request.headers.get('idempotency-key'));
  if (!key.success)
    return problem(400, 'validation_failed', 'An Idempotency-Key header is required');
  const input = await readJson(request, OidcSignupStart);
  if (!input.success) return invalid(input.error);
  const { provider, ...org } = input.data;
  const cells = await deps.controlPlane.listCells();
  const cell = cells?.find((c) => c.id === org.cellId && c.signupOpen);
  if (!cell) {
    return problem(422, 'validation_failed', 'Choose a data region', undefined, [
      { field: 'cellId', code: 'invalid_region', message: 'Choose a data region' },
    ]);
  }
  const redirectUri = `${deps.scheme}://${deps.baseDomain}/signup/callback/${provider}`;
  const started = await startAt(deps, cell.apiBaseUrl, provider, redirectUri, request);
  if (!started) {
    return problem(503, 'service_unavailable', 'SalesMaker is briefly unavailable');
  }
  return json(
    { authorizationUrl: started.authorizationUrl },
    {
      headers: {
        'set-cookie': setStateCookie(deps.scheme, {
          provider,
          redirectUri,
          ...started,
          signup: { ...org, idempotencyKey: key.data },
        }),
      },
    },
  );
}

/**
 * GET /signup/callback/{provider}: create the organisation, then continue on the new workspace's
 * own host. The session the cell opened here is revoked at once: the refresh cookie must belong
 * to the workspace host, so the browser signs in there (the IdP session makes that one click).
 */
export async function completeSignup(request: Request, deps: ApexDeps, provider: string) {
  if (!isProvider(provider)) return problem(404, 'not_found', 'Not found');
  const clear = clearStateCookie(deps.scheme);
  const back = (error: string) => redirect(`/sign-up?error=${error}&provider=${provider}`, [clear]);
  const saved = readState(request, deps.scheme);
  if (saved?.provider !== provider || !saved.signup) return back('sso_failed');
  const { idempotencyKey, cellId, ...org } = saved.signup;
  const cells = await deps.controlPlane.listCells();
  const cell = cells?.find((c) => c.id === cellId);
  if (!cell) return back('sso_failed');

  const result = await cellRequest(deps, cell.apiBaseUrl, `/auth/signup/oidc/${provider}`, {
    body: {
      ...org,
      callbackUrl: externalUrl(request, deps.scheme),
      redirectUri: saved.redirectUri,
      state: saved.state,
      nonce: saved.nonce,
      codeVerifier: saved.codeVerifier,
    },
    headers: { 'idempotency-key': idempotencyKey },
    request,
  });
  if (result?.status === 409) return back('slug_taken');
  if (result?.status !== 201) return back('sso_failed');
  const created = OidcSignupResponse.safeParse(result.body);
  if (!created.success) return back('sso_failed');
  if (created.data.login.status === 'ok') {
    await cellRequest(deps, cell.apiBaseUrl, '/auth/logout', {
      body: { refreshToken: created.data.login.tokens.refreshToken },
      headers: { 'x-sm-tenant-id': created.data.tenantId },
      request,
    });
  }
  const origin = workspaceOrigin(created.data.slug, deps.baseDomain, deps.scheme);
  return redirect(`${origin}/sso/${provider}`, [clear]);
}
