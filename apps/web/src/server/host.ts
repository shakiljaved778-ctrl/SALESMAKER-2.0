export type HostKind = { kind: 'apex' } | { kind: 'workspace'; host: string } | { kind: 'invalid' };

const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

/**
 * Classify a request's Host header. The bare base domain (and `www.`) is the apex; anything else
 * is a workspace host — `{slug}.{base}` or a verified custom domain — that only the control plane
 * can resolve. Malformed hosts never reach the directory.
 */
export function classifyHost(rawHost: string | null, baseDomain: string): HostKind {
  const host = (rawHost ?? '').trim().toLowerCase();
  const base = baseDomain.trim().toLowerCase();
  if (!host || host.length > 253 || !HOST_PATTERN.test(host)) return { kind: 'invalid' };
  if (host === base || host === `www.${base}`) return { kind: 'apex' };
  return { kind: 'workspace', host };
}

/** Origin of a workspace, e.g. https://acme.salesmaker.app. */
export function workspaceOrigin(
  slug: string,
  baseDomain: string,
  scheme: 'http' | 'https',
): string {
  return `${scheme}://${slug}.${baseDomain}`;
}
