import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  contrast,
  renderTokensCss,
  semanticTokens,
  type SemanticToken,
  type Theme,
} from '../src/tokens/index.js';

type Pair = [fg: SemanticToken, bg: SemanticToken, min: number];

/** Text pairs need 4.5:1; focus rings and control boundaries need 3:1 (§9.2 contrast rule). */
const TEXT_ON = [
  'bg-canvas',
  'bg-surface',
  'bg-surface-raised',
  'bg-subtle',
  'bg-hover',
  'bg-selected',
  'bg-muted',
] as const;
const pairs: Pair[] = [
  ...(['text-primary', 'text-secondary', 'text-tertiary'] as const).flatMap((fg) =>
    TEXT_ON.map((bg): Pair => [fg, bg, 4.5]),
  ),
  ['text-link', 'bg-surface', 4.5],
  ['text-link', 'bg-canvas', 4.5],
  ['action-primary-fg', 'action-primary-bg', 4.5],
  ['action-primary-fg', 'action-primary-hover', 4.5],
  ['action-primary-fg', 'action-primary-active', 4.5],
  ['action-secondary-fg', 'action-secondary-bg', 4.5],
  ['action-danger-fg', 'action-danger-bg', 4.5],
  ['status-success-fg', 'status-success-bg', 4.5],
  ['status-warning-fg', 'status-warning-bg', 4.5],
  ['status-danger-fg', 'status-danger-bg', 4.5],
  ['status-info-fg', 'status-info-bg', 4.5],
  ['status-neutral-fg', 'status-neutral-bg', 4.5],
  ['ai-accent', 'ai-bg', 4.5],
  ['ai-accent', 'bg-surface', 4.5],
  ['text-on-sidebar', 'bg-sidebar', 4.5],
  ['text-on-sidebar-muted', 'bg-sidebar', 4.5],
  ['text-on-brand', 'bg-brand-from', 4.5],
  ['text-on-brand', 'bg-brand-to', 4.5],
  ['text-on-brand-muted', 'bg-brand-from', 4.5],
  ['text-on-brand-muted', 'bg-brand-to', 4.5],
  ...([1, 2, 3, 4, 5, 6, 7, 8] as const).map((n): Pair => [
    `cat-${String(n)}-fg` as SemanticToken,
    `cat-${String(n)}-bg` as SemanticToken,
    4.5,
  ]),
  ['border-focus', 'bg-surface', 3],
  ['border-focus', 'bg-canvas', 3],
  ['action-primary-bg', 'bg-surface', 3],
  ['action-danger-bg', 'bg-surface', 3],
  ['border-default', 'bg-surface', 3],
];

/**
 * Pairs where the locked §9.2 values miss the rule. Each is an open question for the owner
 * (docs/spec/OPEN_QUESTIONS.md Q27–Q29) with a proposed passing value. `--text-disabled` is
 * exempt by the spec (v1.2) and is not listed. This list must shrink, never silently grow: the
 * test fails if a new pair fails, or if a listed pair starts passing.
 */
const PENDING_OWNER_DECISION = new Set([
  'light text-tertiary/bg-canvas', // Q27: 4.41
  'light text-tertiary/bg-hover', // Q27: 4.14
  'light text-tertiary/bg-muted', // Q27: 4.14
  'light text-tertiary/bg-selected', // Q27: 4.37
  'dark text-tertiary/bg-surface-raised', // Q27: 4.44
  'dark text-tertiary/bg-hover', // Q27: 4.19
  'dark text-tertiary/bg-muted', // Q27: 3.92
  'dark text-tertiary/bg-selected', // Q27: 3.95
  'dark action-danger-fg/action-danger-bg', // Q28: 4.11
  'light border-default/bg-surface', // Q29: 1.28 (input boundaries, WCAG 1.4.11)
  'dark border-default/bg-surface', // Q29: 1.36
]);

describe('token contrast (§9.2, WCAG 2.2 AA)', () => {
  for (const theme of ['light', 'dark'] as Theme[]) {
    for (const [fg, bg, min] of pairs) {
      const key = `${theme} ${fg}/${bg}`;
      const ratio = contrast(semanticTokens[theme][fg], semanticTokens[theme][bg]);
      if (PENDING_OWNER_DECISION.has(key)) {
        it(`${key} is still below ${String(min)}:1 (pending owner decision)`, () => {
          expect(ratio).toBeLessThan(min);
        });
      } else {
        it(`${key} ≥ ${String(min)}:1`, () => {
          expect(ratio, `${key} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(min);
        });
      }
    }
  }
});

describe('generated CSS', () => {
  it('src/styles/tokens.css matches the TypeScript tokens (run `pnpm --filter @sm/ui tokens`)', () => {
    expect(readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8')).toBe(
      renderTokensCss(),
    );
  });

  it('defines dark values for explicit dark and for system-dark, and all three densities', () => {
    const css = renderTokensCss();
    expect(css).toContain(":root[data-theme='dark']");
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)[\s\S]*:root\[data-theme='system'\]/);
    expect(css).toContain(":root[data-density='comfortable']");
    expect(css).toContain(":root[data-density='compact']");
    expect(css).toContain('--row-height: 28px;');
  });
});
