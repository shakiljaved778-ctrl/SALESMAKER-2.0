import { EmailRequest, SignupRequest, SignupResponse } from '@sm/contracts';
import { isLocale } from '@sm/i18n';
import { z } from 'zod';

import { PREFERENCE_COOKIES } from '../lib/preferences';
import { cellRequest, invalid, readJson, relayProblem, unavailable, type BffDeps } from './bff';
import type { ControlPlane } from './control-plane';
import { classifyHost } from './host';
import { isSameOrigin, json, problem, readCookie } from './http';

export interface ApexDeps extends BffDeps {
  controlPlane: Pick<ControlPlane, 'listCells' | 'findWorkspaces'>;
}

export type ApexHandler = (request: Request, deps: ApexDeps) => Promise<Response>;

/** Apex-only routes (sign-up, find my workspaces): same-origin POSTs on the bare base domain. */
function onApex(handler: ApexHandler): ApexHandler {
  return async (request, deps) => {
    if (!isSameOrigin(request, deps.scheme)) {
      return problem(403, 'forbidden', 'Request refused', 'Cross-origin requests are not allowed.');
    }
    if (classifyHost(request.headers.get('host'), deps.baseDomain).kind !== 'apex') {
      return problem(404, 'not_found', 'Not found');
    }
    return handler(request, deps);
  };
}

export const SignupForm = SignupRequest.extend({ cellId: z.string().min(1).max(64) });
export const IdempotencyKey = z.string().min(8).max(128);

/**
 * Create an organisation in the region the user chose. The cell comes from the control plane's
 * cell list; the client's Idempotency-Key makes a double-submit or retry replay the first answer.
 */
export const signup: ApexHandler = onApex(async (request, deps) => {
  const key = IdempotencyKey.safeParse(request.headers.get('idempotency-key'));
  if (!key.success) {
    return problem(400, 'validation_failed', 'An Idempotency-Key header is required');
  }
  const input = await readJson(request, SignupForm);
  if (!input.success) return invalid(input.error);
  const { cellId, ...body } = input.data;
  const cells = await deps.controlPlane.listCells();
  if (!cells) return unavailable();
  const cell = cells.find((c) => c.id === cellId && c.signupOpen);
  if (!cell) {
    return problem(422, 'validation_failed', 'Choose a data region', undefined, [
      { field: 'cellId', code: 'invalid_region', message: 'Choose a data region' },
    ]);
  }
  const result = await cellRequest(deps, cell.apiBaseUrl, '/auth/signup', {
    body,
    headers: { 'idempotency-key': key.data },
    request,
  });
  if (!result) return unavailable();
  if (result.status !== 201) return relayProblem(result);
  const created = SignupResponse.safeParse(result.body);
  return created.success ? json(created.data, { status: 201 }) : unavailable();
});

export const findWorkspaces: ApexHandler = onApex(async (request, deps) => {
  const input = await readJson(request, EmailRequest);
  if (!input.success) return invalid(input.error);
  const locale = readCookie(request, PREFERENCE_COOKIES.locale);
  const sent = await deps.controlPlane.findWorkspaces(
    input.data.email,
    isLocale(locale) ? locale : undefined,
  );
  return sent ? json({ status: 'ok' }, { status: 202 }) : unavailable();
});
