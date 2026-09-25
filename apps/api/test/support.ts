import { generateKeyPairSync, randomBytes } from 'node:crypto';

import { withTenant, type CellPrisma } from '@sm/db';
import { createTestCellDatabase, type TestCellDatabase } from '@sm/db/testing';
import { FakeBreachedPasswordChecker, FakeEmailSender } from '@sm/integrations';
import { uuidv7 } from 'uuidv7';
import { inject } from 'vitest';

import { AuthService } from '../src/auth/auth.service.js';
import { PasswordService } from '../src/auth/password.service.js';
import { PRISMA } from '../src/tokens.js';

import { createApiApp, type ApiApp } from '../src/app.js';
import { ApiConfigSchema, type ApiConfig } from '../src/config.js';

export interface TestApi extends ApiApp {
  db: TestCellDatabase;
  config: ApiConfig;
  email: FakeEmailSender;
  /** Create a workspace (tenant_settings) directly in the cell database. */
  seedTenant(slug: string): Promise<string>;
  /** Create a user with a password identity; verified unless stated. */
  seedUser(
    tenantId: string,
    email: string,
    password: string,
    options?: { verified?: boolean },
  ): Promise<string>;
  dispose(): Promise<void>;
}

export const JWT_KEYS = (() => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
})();

/** A real API on a fresh cell database and a Valkey namespace; nothing is mocked. */
export async function startTestApi(overrides: Partial<ApiConfig> = {}): Promise<TestApi> {
  const db = await createTestCellDatabase(inject('pgServerAdminUrl'));
  const config = ApiConfigSchema.parse({
    CELL_ID: 'eu-central-1',
    CELL_DATABASE_URL: db.appUrl,
    REDIS_URL: inject('redisUrl'),
    CONTROL_API_BASE_URL: 'http://control-api.test',
    LOG_LEVEL: 'silent',
    // Unique buckets per test app: every app.inject() request comes from 127.0.0.1.
    RATE_LIMIT_NAMESPACE: `rl:test:${randomBytes(6).toString('hex')}`,
    WEB_BASE_DOMAIN: 'localhost:3000',
    WEB_URL_SCHEME: 'http',
    SMTP_URL: 'smtp://unused.test:25',
    EMAIL_FROM: 'SalesMaker <no-reply@salesmaker.test>',
    BREACHED_PASSWORD_API_URL: 'http://unused.test/hibp',
    EMAIL_ROUTING_PEPPER: 'test-pepper-0123456789abcdef',
    AUTH_JWT_PRIVATE_KEY_PEM: JWT_KEYS.privatePem,
    AUTH_JWT_KID: 'test-1',
    ...overrides,
  });
  const email = new FakeEmailSender();
  const api = await createApiApp(config, {
    email,
    breachedPasswords: new FakeBreachedPasswordChecker(),
  });
  const prisma = api.app.get<symbol, CellPrisma>(PRISMA);
  return {
    ...api,
    db,
    config,
    email,
    async seedTenant(slug) {
      const tenantId = uuidv7();
      await withTenant(prisma, { tenantId }, ({ prisma: tx }) =>
        tx.tenantSettings.create({
          data: {
            tenantId,
            name: `${slug} Ltd`,
            slug,
            region: 'eu-central-1',
            corporateCurrency: 'USD',
            defaultTimezone: 'UTC',
          },
        }),
      );
      return tenantId;
    },
    async seedUser(tenantId, address, password, options = {}) {
      const passwordHash = await api.app.get(PasswordService).hashNew(password);
      return withTenant(prisma, { tenantId }, async (tx) => {
        const { userId } = await api.app.get(AuthService).createPasswordUser(tx, {
          email: address,
          name: address.split('@')[0] ?? 'User',
          passwordHash,
        });
        if (options.verified !== false) {
          await tx.prisma.user.update({
            where: { tenantId_id: { tenantId, id: userId } },
            data: { emailVerifiedAt: new Date(), status: 'ACTIVE' },
          });
        }
        return userId;
      });
    },
    async dispose() {
      await api.close();
      await db.drop();
    },
  };
}
