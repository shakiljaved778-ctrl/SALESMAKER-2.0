/**
 * Content-Security-Policy for every page (§14.1). Scripts need this request's nonce (Next.js
 * reads it from the request's CSP header and stamps its own scripts); nothing is loaded from
 * other origins. Inline style *attributes* are allowed because Radix positions overlays with
 * them; style elements still need the nonce.
 */
export function contentSecurityPolicy(nonce: string, options: { dev: boolean; https: boolean }) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${options.dev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(options.https ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}
