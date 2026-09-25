import { NextResponse, type NextRequest } from 'next/server';

import { contentSecurityPolicy } from './server/csp';

/** Per-request CSP nonce (every page renders dynamically, so each gets its own). */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = contentSecurityPolicy(nonce, {
    dev: process.env.NODE_ENV === 'development',
    https: process.env.WEB_URL_SCHEME !== 'http',
  });
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api/|_next/static|_next/image|icon.svg).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
