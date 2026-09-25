import 'server-only';

import type { BffDeps } from './bff';
import { webEnv } from './env';
import { TenantDirectory } from './tenant-directory';

let deps: BffDeps | undefined;

/** Process-wide BFF dependencies (one directory cache per server instance). */
export function bffDeps(): BffDeps {
  if (!deps) {
    const env = webEnv();
    deps = {
      directory: new TenantDirectory({
        baseUrl: env.CONTROL_API_BASE_URL,
        ttlMs: env.TENANT_CACHE_TTL_SECONDS * 1000,
      }),
      baseDomain: env.WEB_BASE_DOMAIN,
      scheme: env.WEB_URL_SCHEME,
    };
  }
  return deps;
}
