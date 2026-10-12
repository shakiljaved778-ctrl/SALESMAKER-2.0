/** Cloudflare Turnstile, which hosted web forms may load (§7.1). */
const TURNSTILE = 'https://challenges.cloudflare.com';

/**
 * Content-Security-Policy for every page (§14.1). Scripts need this request's nonce (Next.js
 * reads it from the request's CSP header and stamps its own scripts); nothing is loaded from
 * other origins. Inline style *attributes* are allowed because Radix positions overlays with
 * them; style elements still need the nonce.
 *
 * The app may also reach the object-storage origin (`storageOrigin`) for pre-signed uploads.
 *
 * Hosted web forms (`/f/…`, `embeddable`) are the one exception: any site may frame them (the
 * embed snippet), and they may load the Turnstile challenge. Nothing else is ever framable.
 */
export function contentSecurityPolicy(
  nonce: string,
  options: {
    dev: boolean;
    https: boolean;
    embeddable?: boolean;
    storageOrigin?: string | undefined;
  },
) {
  const form = options.embeddable === true;
  // Files go straight to object storage through pre-signed URLs (§3.12): imports upload there.
  const storage = !form && options.storageOrigin ? ` ${options.storageOrigin}` : '';
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${form ? ` ${TURNSTILE}` : ''}${
      options.dev ? " 'unsafe-eval'" : ''
    }`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self'${form ? ` ${TURNSTILE}` : storage}`,
    ...(form ? [`frame-src ${TURNSTILE}`] : []),
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    form ? 'frame-ancestors *' : "frame-ancestors 'none'",
    ...(options.https ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}
