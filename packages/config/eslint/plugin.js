import designTokens from './rules/design-tokens.js';
import logicalCss from './rules/logical-css.js';

/** Local ESLint plugin for SalesMaker-specific rules, registered as `sm`. */
const plugin = {
  meta: { name: '@sm/eslint-plugin', version: '0.0.0' },
  rules: {
    'design-tokens': designTokens,
    'logical-css': logicalCss,
  },
};

export default plugin;
