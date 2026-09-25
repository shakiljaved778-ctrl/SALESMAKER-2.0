import { base, ui } from '@sm/config/eslint';

export default [
  ...base({ tsconfigRootDir: import.meta.dirname }),
  // Emails render with inline styles, so the logical-CSS and token rules apply here too; the
  // email palette file is the token source.
  ...ui({ tokenFiles: ['**/theme.ts'] }),
];
