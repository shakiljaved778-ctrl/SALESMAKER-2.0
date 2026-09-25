import { z } from 'zod';

const CellConfig = z.object({
  id: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/),
  region: z.string(),
  label: z.string(),
  apiBaseUrl: z.url(),
  publicKeyPem: z.string().includes('BEGIN PUBLIC KEY'),
  signupOpen: z.boolean().default(true),
});

export const ControlApiConfigSchema = z.object({
  PORT: z.coerce.number().int().default(4100),
  CP_DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  EMAIL_ROUTING_PEPPER: z.string().min(16),
  /** Host suffix of tenant workspaces, e.g. `salesmaker.app` (prod) or `localhost:3000` (dev). */
  WEB_BASE_DOMAIN: z.string().min(3),
  WEB_URL_SCHEME: z.enum(['https', 'http']).default('https'),
  SMTP_URL: z.string().min(1),
  EMAIL_FROM: z.string().min(3),
  /** JSON array of cells served by this control plane; synchronised into cp_cell at startup. */
  CELLS: z.string().transform((raw, ctx) => {
    try {
      return z.array(CellConfig).min(1).parse(JSON.parse(raw));
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: `CELLS is not a valid cell list: ${(error as Error).message}`,
      });
      return z.NEVER;
    }
  }),
  PENDING_RESERVATION_HOURS: z.coerce.number().int().positive().default(24),
  RATE_LIMIT_NAMESPACE: z.string().default('rl:cp'),
});

export type ControlApiConfig = z.infer<typeof ControlApiConfigSchema>;
export type CellConfig = z.infer<typeof CellConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ControlApiConfig {
  return ControlApiConfigSchema.parse(env);
}
