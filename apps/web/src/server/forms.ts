import { PublicWebFormDto } from '@sm/contracts';
import type { z } from 'zod';

import { cellRequest, relayProblem, unavailable, type BffDeps } from './bff';
import { isSameOrigin, json, problem } from './http';
import { DirectoryUnavailableError, type Tenant } from './tenant-directory';

/*
 * Hosted web-to-lead forms (§7.1, P03 T20): `/f/{slug}/{formId}` on the web app (locally and as
 * `forms.{base}/f/…` in cells). The page and its submissions resolve the workspace by slug through
 * the tenant directory and call the cell's public form endpoints server-side, so the browser only
 * talks to this origin and the cell sees the visitor's IP for its per-IP limit.
 */

export type PublicForm = z.infer<typeof PublicWebFormDto>;

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Submissions are small: fields, consents and attribution. */
const MAX_BODY = 64 * 1024;

export const validFormPath = (slug: string, formId: string) => SLUG.test(slug) && UUID.test(formId);

/**
 * The workspace a form slug names; null when there is none or it is suspended. A pending one is
 * left to its cell (it has no active forms), since the directory may still hold a workspace as
 * pending for a minute after it was activated.
 */
async function tenantBySlug(deps: BffDeps, slug: string): Promise<Tenant | null> {
  const tenant = await deps.directory.resolve(`${slug}.${deps.baseDomain}`);
  return tenant && tenant.status !== 'SUSPENDED' ? tenant : null;
}

export type LoadedForm =
  | { kind: 'ok'; tenant: Tenant; form: PublicForm }
  | { kind: 'not_found' }
  | { kind: 'unavailable' };

/** The form as the hosted page renders it. */
export async function loadPublicForm(
  deps: BffDeps,
  slug: string,
  formId: string,
  locale: string,
): Promise<LoadedForm> {
  if (!validFormPath(slug, formId)) return { kind: 'not_found' };
  let tenant: Tenant | null;
  try {
    tenant = await tenantBySlug(deps, slug);
  } catch (err) {
    if (err instanceof DirectoryUnavailableError) return { kind: 'unavailable' };
    throw err;
  }
  if (!tenant) return { kind: 'not_found' };
  const result = await cellRequest(
    deps,
    tenant.cell.apiBaseUrl,
    `/v1/public/forms/${tenant.tenantId}/${formId}?locale=${encodeURIComponent(locale)}`,
    { method: 'GET' },
  );
  if (!result) return { kind: 'unavailable' };
  if (result.status === 404) return { kind: 'not_found' };
  const parsed = PublicWebFormDto.safeParse(result.body);
  if (result.status !== 200 || !parsed.success) return { kind: 'unavailable' };
  return { kind: 'ok', tenant, form: parsed.data };
}

/**
 * The visitor's address: the last `X-Forwarded-For` hop, which our own load balancer (or the Next
 * server locally) appends; earlier hops are whatever the client claimed.
 */
export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  const last = forwarded?.split(',').at(-1)?.trim();
  return last || request.headers.get('x-real-ip')?.trim() || null;
}

/** `POST /api/forms/{slug}/{formId}`: relay a submission from the hosted page to the cell. */
export async function submitPublicForm(
  request: Request,
  deps: BffDeps,
  slug: string,
  formId: string,
): Promise<Response> {
  // The hosted page (also inside an embed's iframe) is this origin; nothing else posts here.
  if (!isSameOrigin(request, deps.scheme))
    return problem(403, 'forbidden', 'Request refused', 'Cross-origin requests are not allowed.');
  if (!validFormPath(slug, formId)) return problem(404, 'not_found', 'Not found');
  const text = await request.text();
  if (text.length > MAX_BODY)
    return problem(400, 'validation_failed', 'The submission is too large');
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return problem(400, 'validation_failed', 'The request body is not JSON');
  }
  let tenant: Tenant | null;
  try {
    tenant = await tenantBySlug(deps, slug);
  } catch (err) {
    if (err instanceof DirectoryUnavailableError) return unavailable();
    throw err;
  }
  if (!tenant) return problem(404, 'not_found', 'Not found');
  const headers: Record<string, string> = {};
  const ip = clientIp(request);
  if (ip) headers['x-forwarded-for'] = ip;
  const userAgent = request.headers.get('user-agent');
  if (userAgent) headers['user-agent'] = userAgent.slice(0, 500);
  const result = await cellRequest(
    deps,
    tenant.cell.apiBaseUrl,
    `/v1/public/forms/${tenant.tenantId}/${formId}/submissions`,
    { method: 'POST', body, headers, request },
  );
  if (!result) return unavailable();
  if (result.status >= 400) return relayProblem(result);
  return json(result.body, { status: result.status });
}
