import { base } from '@sm/config/eslint';

export default [
  ...base({ tsconfigRootDir: import.meta.dirname }),
  {
    // NestJS injects by constructor parameter types, so these imports must stay value imports.
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },
];
