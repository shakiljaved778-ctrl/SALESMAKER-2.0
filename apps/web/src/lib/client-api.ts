import type { ProblemDetails } from '@sm/contracts';

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; problem: ProblemDetails | null; retryAfter: number | null };

/** Same-origin JSON POST to the BFF. Network failures come back as status 0, never a throw. */
export async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    return { ok: false, status: 0, problem: null, retryAfter: null };
  }
  const text = await response.text();
  const parsed: unknown = text ? safeJson(text) : undefined;
  if (response.ok) return { ok: true, status: response.status, data: parsed as T };
  const retryAfter = Number(response.headers.get('retry-after'));
  return {
    ok: false,
    status: response.status,
    problem: isProblem(parsed) ? parsed : null,
    retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isProblem(value: unknown): value is ProblemDetails {
  return typeof value === 'object' && value !== null && 'code' in value && 'status' in value;
}

/** First error code per field, e.g. { password: 'breached', slug: 'taken' }. */
export function fieldCodes(result: ApiResult<unknown>): Record<string, string> {
  if (result.ok || !result.problem?.errors) return {};
  const codes: Record<string, string> = {};
  for (const e of result.problem.errors) codes[e.field] ??= e.code;
  return codes;
}
