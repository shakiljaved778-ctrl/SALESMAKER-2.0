import { z } from 'zod';

/** Cell API configuration, validated at startup: a bad deploy fails fast, not at first request. */
export const ApiConfigSchema = z.object({
  PORT: z.coerce.number().int().default(4000),
  CELL_ID: z.string().min(1),
  CELL_DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  CONTROL_API_BASE_URL: z.url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Pre-auth limit per client IP: burst and sustained requests per second. */
  RATE_LIMIT_IP_BURST: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_IP_PER_SECOND: z.coerce.number().positive().default(20),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  /** Valkey key namespace for rate-limit buckets. */
  RATE_LIMIT_NAMESPACE: z.string().default('rl:api'),
});

export type ApiConfig = z.infer<typeof ApiConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return ApiConfigSchema.parse(env);
}
