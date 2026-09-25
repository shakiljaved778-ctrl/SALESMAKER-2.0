import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { coverage } from '../vitest/coverage.js';

const root = join(import.meta.dirname, '..', '..', '..');
const workspaces = ['packages', 'apps'].flatMap((dir) =>
  readdirSync(join(root, dir)).map((name) => join(root, dir, name)),
);

describe('coverage gate (§13)', () => {
  it('defaults to 80% lines over src and never counts generated code or stories', () => {
    const gate = coverage();
    expect(gate.thresholds.lines).toBe(80);
    expect(gate.include).toEqual(['src/**/*.{ts,tsx}']);
    expect(gate.exclude).toEqual(expect.arrayContaining(['src/generated/**', '**/*.stories.tsx']));
    expect(coverage({ lines: 90, exclude: ['src/x.ts'] })).toMatchObject({
      thresholds: { lines: 90 },
      exclude: expect.arrayContaining(['src/x.ts', 'src/generated/**']),
    });
  });

  it('is enforced by every workspace that runs vitest', () => {
    const missing = [];
    for (const dir of workspaces) {
      const pkgPath = join(dir, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const test = pkg.scripts?.test ?? '';
      if (!test.includes('vitest')) continue;
      const config = ['vitest.config.ts', 'vitest.config.js']
        .map((f) => join(dir, f))
        .find((f) => existsSync(f));
      const source = config ? readFileSync(config, 'utf8') : '';
      if (!test.includes('--coverage') || !/coverage\(/.test(source)) missing.push(pkg.name);
    }
    expect(missing).toEqual([]);
  });

  it('holds the engine packages to 90% once they exist', () => {
    for (const name of ['formula', 'permissions', 'query-engine']) {
      const config = join(root, 'packages', name, 'vitest.config.ts');
      if (!existsSync(config)) continue;
      expect(readFileSync(config, 'utf8'), name).toMatch(/coverage\(\{[^}]*lines: 90/);
    }
  });
});
