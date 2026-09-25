import { base } from '@sm/config/eslint';

export default [
  ...base({ tsconfigRootDir: import.meta.dirname }),
  { ignores: ['src/generated/**'] },
];
