import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const dir = new URL('../src/components/', import.meta.url);
const INTERACTIVE =
  /from 'radix-ui'|from 'cmdk'|\buse(State|Effect|Context|Callback|Memo|Ref|Id)\b|createContext/;

/**
 * Next.js renders Server Components by default: any module using hooks, context or Radix must
 * declare the client boundary itself, or importing it from a page breaks the web build.
 */
describe('client boundary', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.tsx') && !f.includes('.stories.'));
  it.each(files)('%s declares "use client" when it is interactive', (file) => {
    const source = readFileSync(new URL(file, dir), 'utf8');
    if (INTERACTIVE.test(source)) expect(source.startsWith("'use client';")).toBe(true);
  });
});
