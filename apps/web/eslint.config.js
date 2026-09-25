import { base, ui } from '@sm/config/eslint';

export default [
  { ignores: ['.next/**', 'next-env.d.ts'] },
  ...base({ tsconfigRootDir: import.meta.dirname }),
  ...ui({ tokenFiles: [] }),
];
