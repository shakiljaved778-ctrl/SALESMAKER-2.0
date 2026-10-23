#!/usr/bin/env node
// Demo hosting (docs/runbooks/demo-hosting.md): give each demo workspace its own vercel.app
// address through the control plane's custom-domain table, since *.vercel.app has no wildcard.
// DEMO_ALIASES=slug=host[,slug=host…]. Idempotent; run after the seed.
import { createRequire } from 'node:module';

const pg = createRequire(new URL('../../packages/db/package.json', import.meta.url))('pg');

const pairs = (process.env.DEMO_ALIASES ?? '')
  .split(',')
  .map((pair) => pair.trim().split('='))
  .filter(([slug, host]) => slug && host);
if (pairs.length === 0) {
  process.stderr.write('Set DEMO_ALIASES in infra/demo/demo.env, e.g. acme=acme-demo.vercel.app\n');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.CP_DATABASE_URL });
await client.connect();
try {
  for (const [slug, rawHost] of pairs) {
    const host = rawHost
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '')
      .toLowerCase();
    const { rows } = await client.query('SELECT id FROM cp_tenant WHERE slug = $1', [slug]);
    if (!rows[0]) {
      process.stderr.write(`No workspace "${slug}" yet: run the seed first.\n`);
      process.exitCode = 1;
      continue;
    }
    await client.query(
      `INSERT INTO cp_tenant_domain (host, tenant_id) VALUES ($1, $2)
       ON CONFLICT (host) DO UPDATE SET tenant_id = EXCLUDED.tenant_id`,
      [host, rows[0].id],
    );
    process.stdout.write(`${slug} → https://${host}\n`);
  }
} finally {
  await client.end();
}
