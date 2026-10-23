import { NextResponse, type NextRequest } from 'next/server';

import { contentSecurityPolicy } from './server/csp';
import { webEnvProblems } from './server/env';

/** Where every page goes while the deployment lacks its required settings. */
const NOT_CONFIGURED = '/not-configured';

/** `forms.{base}/{slug}/{formId}`: the cells' short form address (§7.1). */
const SHORT_FORM_PATH = /^\/([a-z0-9][a-z0-9-]{0,62})\/([0-9a-f]{8}-[0-9a-f-]{27})\/?$/i;

/** The configured object-storage origin, when it is a plain http(s) origin. */
function storageOrigin(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return /^https?:$/.test(url.protocol) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Per-request CSP nonce (every page renders dynamically, so each gets its own). */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const base = process.env.WEB_BASE_DOMAIN?.toLowerCase();
  const host = request.headers.get('host')?.toLowerCase();
  const short = SHORT_FORM_PATH.exec(pathname);
  if (base && host === `forms.${base}` && short) {
    const url = request.nextUrl.clone();
    url.pathname = `/f/${short[1] ?? ''}/${short[2] ?? ''}`;
    return NextResponse.redirect(url, 308);
  }
  const misconfigured = webEnvProblems().length > 0;
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = contentSecurityPolicy(nonce, {
    dev: process.env.NODE_ENV === 'development',
    https: process.env.WEB_URL_SCHEME !== 'http',
    embeddable: pathname.startsWith('/f/'),
    storageOrigin: storageOrigin(process.env.STORAGE_PUBLIC_ORIGIN),
  });
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const response = misconfigured
    ? NextResponse.rewrite(new URL(NOT_CONFIGURED, request.url), {
        request: { headers },
        status: 503,
      })
    : NextResponse.next({ request: { headers } });
  response.headers.set('content-security-policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api/|_next/static|_next/image|icon.svg|forms/embed.js).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
