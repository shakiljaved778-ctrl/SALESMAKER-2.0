// Regenerates src/styles/tokens.css from the TypeScript tokens (run: pnpm --filter @sm/ui tokens).
import { writeFileSync } from 'node:fs';

import { renderTokensCss } from '../dist/tokens/css.js';

writeFileSync(new URL('../src/styles/tokens.css', import.meta.url), renderTokensCss());
process.stdout.write('src/styles/tokens.css written\n');
