/**
 * The refresh token lives only in an httpOnly cookie on the workspace host; the access token is
 * handed to the page and kept in memory (P00 plan, risk 5). SameSite=Lax as §6.1 specifies; the
 * BFF's exact-Origin check is the CSRF defence for its POST routes. Over HTTPS the `__Host-` prefix pins
 * the cookie to this exact host (no Domain, Path=/, Secure), so one workspace can never read
 * another's session. Plain-http local development drops the prefix and Secure.
 */
export function refreshCookieName(scheme: 'http' | 'https'): string {
  return scheme === 'https' ? '__Host-sm_rt' : 'sm_rt';
}

export function setRefreshCookie(
  scheme: 'http' | 'https',
  token: string,
  expiresAt: string,
  now: number = Date.now(),
): string {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
  return [
    `${refreshCookieName(scheme)}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${String(maxAge)}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(scheme === 'https' ? ['Secure'] : []),
  ].join('; ');
}

export function clearRefreshCookie(scheme: 'http' | 'https'): string {
  return [
    `${refreshCookieName(scheme)}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
    ...(scheme === 'https' ? ['Secure'] : []),
  ].join('; ');
}
