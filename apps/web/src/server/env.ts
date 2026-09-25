import { z } from 'zod';

const WebEnvSchema = z.object({
  /** Global control plane: the tenant directory. Cell URLs are never configured here (§3.4). */
  CONTROL_API_BASE_URL: z.url(),
  /** Workspaces live at {slug}.{WEB_BASE_DOMAIN}; the bare domain is the apex (signup, find). */
  WEB_BASE_DOMAIN: z.string().min(3),
  WEB_URL_SCHEME: z.enum(['https', 'http']).default('https'),
  TENANT_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),
});

export type WebEnv = z.infer<typeof WebEnvSchema>;

let cached: WebEnv | undefined;

/** Validated server environment; fails fast with every problem listed. */
export function webEnv(): WebEnv {
  cached ??= WebEnvSchema.parse(process.env);
  return cached;
}
