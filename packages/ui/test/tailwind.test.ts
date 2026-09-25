import { readFileSync } from 'node:fs';

import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

async function compile(classes: string): Promise<string> {
  const entry = new URL('../src/styles/index.css', import.meta.url);
  const css = `${readFileSync(entry, 'utf8')}\n@source inline("${classes}");`;
  const result = await postcss([
    tailwind({ base: new URL('..', import.meta.url).pathname }),
  ]).process(css, {
    from: entry.pathname,
  });
  return result.css;
}

describe('Tailwind v4 theme', () => {
  it('generates token-backed utilities that switch at runtime (theme inline → var())', async () => {
    const css = await compile(
      'bg-surface text-fg text-fg-tertiary border-line bg-primary text-on-primary text-title-1 text-body bg-ai-bg shadow-e2 rounded-md ms-4 pe-2 tabular',
    );
    expect(css).toMatch(/\.bg-surface\s*\{\s*background-color: var\(--bg-surface\)/);
    expect(css).toMatch(/\.text-fg-tertiary\s*\{\s*color: var\(--text-tertiary\)/);
    expect(css).toMatch(/\.text-body\s*\{[^}]*font-size: var\(--font-body-size\)/);
    expect(css).toMatch(/\.shadow-e2\s*\{/);
    expect(css).toMatch(/\.ms-4\s*\{\s*margin-inline-start:/);
    expect(css).toContain('font-variant-numeric: tabular-nums');
  });

  it('includes the base layer: focus ring, RTL mirroring, reduced motion', async () => {
    const css = await compile('bg-canvas');
    expect(css).toContain('outline: 2px solid var(--border-focus)');
    expect(css).toMatch(/\[dir='rtl'\] \[data-mirror\]/);
    expect(css).toContain('prefers-reduced-motion: reduce');
  });
});
