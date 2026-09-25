#!/usr/bin/env node
// Local development setup (§13.6). Idempotent:
//  1. generates Ed25519 keys in .secrets/ (access-token signing key, cell service key), if missing;
//  2. creates .env from .env.example if missing, pointing at the keys and registering the local
//     cell (with its service public key) in CELLS for the control plane.
// Never used for deployed environments: those take keys from AWS Secrets Manager.
import { createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const secrets = new URL('.secrets/', root);
mkdirSync(secrets, { recursive: true, mode: 0o700 });

function ensureKey(name) {
  const file = new URL(name, secrets);
  if (!existsSync(file)) {
    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    process.stdout.write(`generated .secrets/${name}\n`);
  }
  return readFileSync(file, 'utf8');
}

ensureKey('jwt-ed25519.pem');
const cellKey = ensureKey('cell-service-ed25519.pem');
const cellPublic = createPublicKey(cellKey).export({ type: 'spki', format: 'pem' }).toString();

const envFile = new URL('.env', root);
if (existsSync(envFile)) {
  process.stdout.write('.env exists; left unchanged\n');
} else {
  const cells = [
    {
      id: 'eu-central-1',
      region: 'eu-central-1',
      label: 'European Union (Frankfurt)',
      apiBaseUrl: 'http://localhost:4000',
      publicKeyPem: cellPublic,
      signupOpen: true,
    },
  ];
  const env = readFileSync(new URL('.env.example', root), 'utf8')
    .replace(/^CELLS=.*$/m, `CELLS='${JSON.stringify(cells)}'`)
    .replace(/^SECRETS_KEY=.*$/m, `SECRETS_KEY=${randomBytes(32).toString('base64')}`)
    .replace(
      /^EMAIL_ROUTING_PEPPER=.*$/m,
      `EMAIL_ROUTING_PEPPER=dev-${randomBytes(12).toString('hex')}`,
    );
  writeFileSync(envFile, env, { mode: 0o600 });
  process.stdout.write('wrote .env\n');
}
