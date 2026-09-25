import { base, ui } from '@sm/config/eslint';

// Token source files (palette, semantic, scales, generated CSS helpers) hold the raw values
// that everything else must reference (golden rule 6).
export default [
  ...base({ tsconfigRootDir: import.meta.dirname }),
  ...ui({ tokenFiles: ['src/tokens/**', 'test/tokens*'] }),
];
