// `generate` writes messages/en-XA.json from en.json; `check` validates the catalogue and fails if
// the pseudo-locale is stale. Runs after build (needs dist/).
import { readFileSync, writeFileSync } from 'node:fs';

import { checkCatalogue, toPseudo } from '../dist/catalogue.js';

const read = (name) =>
  JSON.parse(readFileSync(new URL(`../messages/${name}.json`, import.meta.url), 'utf8'));
const pseudoText = () => `${JSON.stringify(toPseudo(read('en')), null, 2)}\n`;
const pseudoUrl = new URL('../messages/en-XA.json', import.meta.url);

const mode = process.argv[2];
if (mode === 'generate') {
  writeFileSync(pseudoUrl, pseudoText());
} else if (mode === 'check') {
  const problems = checkCatalogue(read('en'));
  for (const p of problems) process.stderr.write(`i18n ✗ ${p.key}: ${p.problem}\n`);
  const isStale = () => {
    try {
      return readFileSync(pseudoUrl, 'utf8') !== pseudoText();
    } catch {
      return true;
    }
  };
  const stale = isStale();
  if (stale)
    process.stderr.write(
      'i18n ✗ messages/en-XA.json is stale: run `pnpm --filter @sm/i18n build`\n',
    );
  if (problems.length || stale) process.exit(1);
  process.stdout.write('i18n check passed\n');
} else {
  process.stderr.write('usage: i18n.js generate|check\n');
  process.exit(2);
}
