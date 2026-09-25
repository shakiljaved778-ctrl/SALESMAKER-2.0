import { problemType, type ErrorCode, type FieldError, type ProblemDetails } from '@sm/contracts';
import type { z } from 'zod';

/** RFC 9457 response from the BFF itself (upstream problems are relayed as they are). */
export function problem(
  status: number,
  code: ErrorCode,
  title: string,
  detail?: string,
  errors?: z.infer<typeof FieldError>[],
): Response {
  const body: ProblemDetails = {
    type: problemType(code),
    title,
    status,
    code,
    ...(detail ? { detail } : {}),
    ...(errors ? { errors } : {}),
  };
  return Response.json(body, {
    status,
    headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' },
  });
}

export function json(body: unknown, init: { status?: number; headers?: HeadersInit } = {}) {
  const headers = new Headers(init.headers);
  headers.set('cache-control', 'no-store');
  return Response.json(body, { status: init.status ?? 200, headers });
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * CSRF defence for state-changing BFF routes: browsers always send Origin on cross-origin and
 * same-origin POSTs, so anything but this exact workspace origin is refused.
 */
export function isSameOrigin(request: Request, scheme: 'http' | 'https'): boolean {
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  return Boolean(origin && host && origin === `${scheme}://${host.toLowerCase()}`);
}
