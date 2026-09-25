import js from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import smPlugin from './plugin.js';

const IGNORES = {
  ignores: [
    '**/dist/**',
    '**/.next/**',
    '**/coverage/**',
    '**/storybook-static/**',
    '**/node_modules/**',
    '**/*.d.ts',
  ],
};

/**
 * Base config for every workspace: typescript-eslint strict, no console, and the module
 * boundary rules from §13.1 (apps may import packages; packages never import apps).
 */
export function base({ tsconfigRootDir }) {
  return tseslint.config(
    IGNORES,
    js.configs.recommended,
    ...tseslint.configs.strictTypeChecked,
    {
      languageOptions: {
        globals: { ...globals.node },
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      plugins: { boundaries },
      settings: {
        'boundaries/elements': [
          { type: 'app', pattern: 'apps/*' },
          { type: 'package', pattern: 'packages/*' },
        ],
      },
      rules: {
        'no-console': 'error',
        'boundaries/element-types': [
          'error',
          {
            default: 'allow',
            rules: [
              {
                from: 'package',
                disallow: ['app'],
                message: 'packages/* must never import apps/* (§13.1).',
              },
            ],
          },
        ],
        '@typescript-eslint/consistent-type-imports': 'error',
        '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      },
    },
    {
      files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
      ...tseslint.configs.disableTypeChecked,
    },
  );
}

/**
 * Extra rules for UI code (apps/web, packages/ui): RTL-safe logical CSS (§9.12) and design
 * tokens only (golden rule 6). Token source files are exempt from the colour rule.
 */
export function ui({ tokenFiles = ['**/tokens/**'] } = {}) {
  return [
    {
      files: ['**/*.{ts,tsx,js,jsx}'],
      languageOptions: { globals: { ...globals.browser } },
      plugins: { sm: smPlugin },
      rules: {
        'sm/logical-css': 'error',
        'sm/design-tokens': 'error',
      },
    },
    { files: tokenFiles, rules: { 'sm/design-tokens': 'off' } },
  ];
}
