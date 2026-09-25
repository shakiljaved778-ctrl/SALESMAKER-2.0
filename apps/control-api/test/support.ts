import { execFile } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

import { FakeEmailSender } from '@sm/integrations';
import { emailRoutingHmac, importEd25519PrivateKey, signServiceToken } from '@sm/server-kit';
import pg from 'pg';
import { inject } from 'vitest';

import { createControlApiApp, type ControlApiApp } from '../src/app.js';
import { ControlApiConfigSchema, type ControlApiConfig } from '../src/config.js';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

export const PEPPER = 'test-pepper-0123456789abcdef';

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

export interface TestControlApi extends ControlApiApp {
  config: ControlApiConfig;
  email: FakeEmailSender;
  dbUrl: string;
  /** Private key PEM of a registered cell (for building real clients in tests). */
  privateKeyPem(cell: 'eu-central-1' | 'me-central-1' | 'rogue'): string;
  /** A service token for a registered cell, or signed by an unregistered key ("rogue"). */
  tokenFor(cell: 'eu-central-1' | 'me-central-1' | 'rogue'): Promise<string>;
  hmac(email: string): string;
  dispose(): Promise<void>;
}

export async function startTestControlApi(): Promise<TestControlApi> {
  const serverUrl = inject('pgServerAdminUrl');
  const name = `sm_cp_test_${randomBytes(6).toString('hex')}`;
  const server = new pg.Client({ connectionString: serverUrl });
  await server.connect();
  await server.query(`CREATE DATABASE ${name}`);
  await server.end();
  const dbUrl = Object.assign(new URL(serverUrl), { pathname: `/${name}` }).toString();
  const prismaCli = require.resolve('prisma/build/index.js');
  await run(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    env: { ...process.env, CP_DATABASE_URL: dbUrl },
  });

  const keys = { 'eu-central-1': keyPair(), 'me-central-1': keyPair(), rogue: keyPair() };
  const config = ControlApiConfigSchema.parse({
    CP_DATABASE_URL: dbUrl,
    REDIS_URL: inject('redisUrl'),
    LOG_LEVEL: 'silent',
    EMAIL_ROUTING_PEPPER: PEPPER,
    WEB_BASE_DOMAIN: 'localhost:3000',
    WEB_URL_SCHEME: 'http',
    SMTP_URL: 'smtp://unused.test:25',
    EMAIL_FROM: 'SalesMaker <no-reply@salesmaker.test>',
    RATE_LIMIT_NAMESPACE: `rl:cp-test:${randomBytes(6).toString('hex')}`,
    CELLS: JSON.stringify([
      {
        id: 'eu-central-1',
        region: 'eu-central-1',
        label: 'European Union',
        apiBaseUrl: 'http://eu.api.test',
        publicKeyPem: keys['eu-central-1'].publicPem,
      },
      {
        id: 'me-central-1',
        region: 'me-central-1',
        label: 'UAE (GCC)',
        apiBaseUrl: 'http://me.api.test',
        publicKeyPem: keys['me-central-1'].publicPem,
        signupOpen: false,
      },
    ]),
  });
  const email = new FakeEmailSender();
  const api = await createControlApiApp(config, { email });
  return {
    ...api,
    config,
    email,
    dbUrl,
    async tokenFor(cell) {
      const cellId = cell === 'rogue' ? 'eu-central-1' : cell;
      return signServiceToken(await importEd25519PrivateKey(keys[cell].privatePem), {
        cellId,
        kid: 'test',
      });
    },
    hmac: (address) => emailRoutingHmac(address, PEPPER).toString('base64url'),
    privateKeyPem: (cell) => keys[cell].privatePem,
    async dispose() {
      await api.close();
      const c = new pg.Client({ connectionString: serverUrl });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
