'use client';

import type { ApiResult } from './client-api';
import { accessToken, refreshSession, rememberSession } from './session';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

async function send<T>(method: Method, path: string, body?: unknown): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  const token = accessToken();
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return { ok: false, status: 0, problem: null, retryAfter: null };
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    parsed = undefined;
  }
  if (response.ok) return { ok: true, status: response.status, data: parsed as T };
  const retryAfter = Number(response.headers.get('retry-after'));
  const problem =
    typeof parsed === 'object' && parsed !== null && 'code' in parsed && 'status' in parsed
      ? (parsed as Extract<ApiResult<T>, { ok: false }>['problem'])
      : null;
  return {
    ok: false,
    status: response.status,
    problem,
    retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
  };
}

/**
 * Call the signed-in cell API through the BFF relay (`/api/v1/…`). The access token lives in page
 * memory; when it has expired the cell answers 401, so the session is refreshed once (rotating
 * the refresh cookie) and the call retried.
 */
export async function cellApi<T>(
  method: Method,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const first = await send<T>(method, path, body);
  if (first.ok || first.status !== 401) return first;
  const refreshed = await refreshSession();
  if (!refreshed.ok) return first;
  rememberSession(refreshed.data);
  return send<T>(method, path, body);
}

/** Query string from a filter object, dropping empty values. */
export function query(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  const text = search.toString();
  return text ? `?${text}` : '';
}
