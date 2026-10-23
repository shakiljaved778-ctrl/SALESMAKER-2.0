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

/**
 * Names of the variables that are missing or invalid (empty when the environment is valid). Names
 * only, never values: this is shown on the not-configured page and by /api/health.
 */
export function webEnvProblems(env: Record<string, string | undefined> = process.env): string[] {
  const result = WebEnvSchema.safeParse(env);
  if (result.success) return [];
  return [...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? '')))].filter(
    Boolean,
  );
}

/** Validated server environment; fails fast with every problem listed. */
export function webEnv(): WebEnv {
  cached ??= WebEnvSchema.parse(process.env);
  return cached;
}
