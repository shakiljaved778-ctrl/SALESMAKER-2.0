#!/usr/bin/env node
// Bootstrap and migrate the local databases (run with `pnpm db:setup`, after `docker compose up -d`
// and `pnpm setup:dev`). Idempotent. Paths in .env are relative to the app directories.
import { execFileSync } from 'node:child_process';

const run = (cwd, args, env = {}) =>
  execFileSync('pnpm', args, {
    cwd: new URL(cwd, new URL('..', import.meta.url)),
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });

// Through turbo, so the Prisma client is generated before the package compiles.
run('./', ['turbo', 'run', 'build', '--filter=@sm/db']);
run('packages/db/', ['db:bootstrap']);
run('packages/db/', ['db:migrate']);
run('apps/control-api/', ['db:migrate']);
process.stdout.write('databases ready\n');
