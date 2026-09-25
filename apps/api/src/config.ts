import { readFileSync } from 'node:fs';

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

  // ── Web links in emails ───────────────────────────────────────────────────
  WEB_BASE_DOMAIN: z.string().min(3),
  WEB_URL_SCHEME: z.enum(['https', 'http']).default('https'),

  // ── Email and third parties (fakes locally, §10.5) ────────────────────────
  SMTP_URL: z.string().min(1),
  EMAIL_FROM: z.string().min(3),
  BREACHED_PASSWORD_API_URL: z.url(),
  EMAIL_ROUTING_PEPPER: z.string().min(16),

  // ── Session tokens (§6.1) ──────────────────────────────────────────────────
  /** Ed25519 private key (PKCS#8 PEM) that signs access tokens; or give AUTH_JWT_PRIVATE_KEY_PATH. */
  AUTH_JWT_PRIVATE_KEY_PEM: z.string().includes('PRIVATE KEY'),
  AUTH_JWT_KID: z.string().min(1),
  /** Previous public keys still accepted during rotation: JSON [{ "kid", "publicKeyPem" }]. */
  AUTH_JWT_PREVIOUS_KEYS: z
    .string()
    .default('[]')
    .transform((raw) =>
      z.array(z.object({ kid: z.string(), publicKeyPem: z.string() })).parse(JSON.parse(raw)),
    ),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  // ── Social sign-in (§6.1). A provider is enabled when its issuer is set. ─────
  OIDC_GOOGLE_ISSUER: z.url().optional(),
  OIDC_GOOGLE_CLIENT_ID: z.string().optional(),
  OIDC_GOOGLE_CLIENT_SECRET: z.string().optional(),
  OIDC_MICROSOFT_ISSUER: z.url().optional(),
  OIDC_MICROSOFT_CLIENT_ID: z.string().optional(),
  OIDC_MICROSOFT_CLIENT_SECRET: z.string().optional(),
  /** Only for the local HTTP fakes. Refused when NODE_ENV=production. */
  OIDC_ALLOW_INSECURE_HTTP: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // ── Cell ↔ control plane service identity (§3.4) ─────────────────────────
  /** Ed25519 private key (PKCS#8 PEM) this cell signs control-plane calls with; or _PATH. */
  CELL_SERVICE_PRIVATE_KEY_PEM: z.string().includes('PRIVATE KEY'),
  CELL_SERVICE_KID: z.string().min(1).default('cell-1'),
  /** Signups per client IP per hour. */
  SIGNUP_RATE_PER_HOUR: z.coerce.number().int().positive().default(10),

  // ── Secrets at rest (§6.6): AES-256-GCM key ring; KMS-provided in deployed cells ──
  SECRETS_KEY_ID: z.string().min(1).default('local-1'),
  /** 32 random bytes, base64. */
  SECRETS_KEY: z.string().min(40),
  /** Older keys still able to decrypt: JSON { "<id>": "<base64 key>" }. */
  SECRETS_PREVIOUS_KEYS: z
    .string()
    .default('{}')
    .transform((raw) => z.record(z.string(), z.string()).parse(JSON.parse(raw))),
});

export type ApiConfig = z.infer<typeof ApiConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const fromFile = (pemVar: string, pathVar: string) => {
    const path = env[pathVar];
    return path && !env[pemVar] ? { [pemVar]: readFileSync(path, 'utf8') } : {};
  };
  const withKey = {
    ...env,
    ...fromFile('AUTH_JWT_PRIVATE_KEY_PEM', 'AUTH_JWT_PRIVATE_KEY_PATH'),
    ...fromFile('CELL_SERVICE_PRIVATE_KEY_PEM', 'CELL_SERVICE_PRIVATE_KEY_PATH'),
  };
  const config = ApiConfigSchema.parse(withKey);
  if (config.OIDC_ALLOW_INSECURE_HTTP && env['NODE_ENV'] === 'production') {
    throw new Error('OIDC_ALLOW_INSECURE_HTTP must not be enabled in production');
  }
  return config;
}
