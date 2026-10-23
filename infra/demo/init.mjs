#!/usr/bin/env node
// Demo hosting, one-time and idempotent (docs/runbooks/demo-hosting.md). Runs in the migrate
// image: `docker compose -f infra/demo/docker-compose.yml run --rm init`.
//  1. keys and secrets into infra/demo/.state/ (kept on later runs);
//  2. the cell database on Neon: roles with generated passwords, extensions, grants;
//  3. cell and control-plane migrations;
//  4. .state/generated.env for the services (database URLs per role, CELLS, secrets).
import { execFileSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { bootstrapCell } from '../../packages/db/scripts/bootstrap-lib.js';

const pg = createRequire(new URL('../../packages/db/package.json', import.meta.url))('pg');
const state = new URL('.state/', import.meta.url);
const keys = new URL('keys/', state);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value || value.includes('example') || value.includes('password@')) {
    process.stderr.write(`Set ${name} in infra/demo/demo.env (see demo.env.example).\n`);
    process.exit(1);
  }
  return value;
}

const cellUrl = new URL(required('NEON_CELL_URL'));
const cpUrl = required('NEON_CP_URL');
const ngrokDomain = required('NGROK_DOMAIN')
  .replace(/^https?:\/\//, '')
  .replace(/\/$/, '');
required('WEB_BASE_DOMAIN');
if ((process.env.SEED_PASSWORD ?? '').length < 12) {
  process.stderr.write('Set SEED_PASSWORD in infra/demo/demo.env (12+ characters).\n');
  process.exit(1);
}

mkdirSync(keys, { recursive: true });
chmodSync(keys, 0o755);

function ensureKey(name) {
  const file = new URL(name, keys);
  if (!existsSync(file)) {
    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  }
  // Read by the services' non-root user through a read-only mount.
  chmodSync(file, 0o644);
  return readFileSync(file, 'utf8');
}
ensureKey('jwt-ed25519.pem');
const cellKey = ensureKey('cell-service-ed25519.pem');

// Secrets survive re-runs, so the roles' passwords and encrypted data stay valid.
const secretsFile = new URL('secrets.json', state);
const secrets = existsSync(secretsFile) ? JSON.parse(readFileSync(secretsFile, 'utf8')) : {};
const hex = (n) => randomBytes(n).toString('hex');
secrets.migrator ??= hex(24);
secrets.app ??= hex(24);
secrets.reports ??= hex(24);
secrets.audit ??= hex(24);
secrets.pepper ??= hex(24);
secrets.secretsKey ??= randomBytes(32).toString('base64');
writeFileSync(secretsFile, JSON.stringify(secrets, null, 2), { mode: 0o600 });

/** The cell database URL for one role (same Neon host and database as NEON_CELL_URL). */
function roleUrl(role, password) {
  const url = new URL(cellUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

process.stdout.write('Preparing the cell database on Neon (roles, extensions, grants)…\n');
const admin = new pg.Client({ connectionString: cellUrl.toString() });
await admin.connect();
try {
  await bootstrapCell(admin, {
    migratorPassword: secrets.migrator,
    appPassword: secrets.app,
    reportsPassword: secrets.reports,
    auditPassword: secrets.audit,
  });
} finally {
  await admin.end();
}

const migrate = (cwd, env) =>
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: new URL(cwd, new URL('../../', import.meta.url)),
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
process.stdout.write('Migrating the cell database…\n');
migrate('packages/db/', { CELL_DATABASE_URL_MIGRATOR: roleUrl('sm_migrator', secrets.migrator) });
process.stdout.write('Migrating the control-plane database…\n');
migrate('apps/control-api/', { CP_DATABASE_URL: cpUrl });

const cells = [
  {
    id: process.env.CELL_ID ?? 'eu-central-1',
    region: 'eu-central-1',
    label: 'Demo',
    apiBaseUrl: `https://${ngrokDomain}`,
    publicKeyPem: createPublicKey(cellKey).export({ type: 'spki', format: 'pem' }).toString(),
    signupOpen: true,
  },
];
const lines = [
  '# Written by infra/demo/init.mjs. Do not edit or commit; re-run init to regenerate.',
  `CELL_DATABASE_URL=${roleUrl('sm_app', secrets.app)}`,
  `CELL_AUDIT_DATABASE_URL=${roleUrl('sm_audit', secrets.audit)}`,
  `CP_DATABASE_URL=${cpUrl}`,
  `CELLS='${JSON.stringify(cells)}'`,
  `EMAIL_ROUTING_PEPPER=${secrets.pepper}`,
  `SECRETS_KEY=${secrets.secretsKey}`,
];
writeFileSync(new URL('generated.env', state), `${lines.join('\n')}\n`, { mode: 0o644 });
process.stdout.write('Done. Next: docker compose -f infra/demo/docker-compose.yml up -d --build\n');
