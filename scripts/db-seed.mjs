#!/usr/bin/env node
// Seed the demo workspaces (run with `pnpm db:seed --scenario=agency|bank|all [--scale=demo|load]`,
// after `pnpm db:setup` and with the control API running, e.g. `pnpm dev`). Idempotent.
import { execFileSync } from 'node:child_process';

const root = new URL('..', import.meta.url);
execFileSync('pnpm', ['turbo', 'run', 'build', '--filter=@sm/api'], {
  cwd: root,
  stdio: 'inherit',
});
execFileSync('node', ['dist/seed/main.js', ...process.argv.slice(2)], {
  cwd: new URL('apps/api/', root),
  stdio: 'inherit',
});
