import { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';

import designTokens from '../eslint/rules/design-tokens.js';
import logicalCss, { findPhysicalUtilities } from '../eslint/rules/logical-css.js';

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

describe('findPhysicalUtilities', () => {
  it('finds physical utilities through variants, important and negative prefixes', () => {
    expect(findPhysicalUtilities('ms-2 ml-2 hover:pr-4 !text-left -mr-1 md:rounded-tl-lg')).toEqual(
      ['ml-2', 'hover:pr-4', '!text-left', '-mr-1', 'md:rounded-tl-lg'],
    );
  });

  it('accepts logical utilities and unrelated words', () => {
    expect(
      findPhysicalUtilities(
        'ms-2 me-2 ps-4 pe-4 start-0 end-0 text-start border-s rounded-s-md mx-2 top-left',
      ),
    ).toEqual([]);
  });
});

tester.run('sm/logical-css', logicalCss, {
  valid: [
    'const c = "ms-2 pe-4 text-start border-e rounded-e-md";',
    'const s = { marginInlineStart: 8, paddingInlineEnd: 4, textAlign: "start" };',
    'const x = <div className="start-0 end-4" />;',
  ],
  invalid: [
    { code: 'const c = "ml-2";', errors: [{ messageId: 'utility' }] },
    { code: 'const c = `p-2 ${a} text-right`;', errors: [{ messageId: 'utility' }] },
    {
      code: 'const x = <div className="left-0 border-r" />;',
      errors: [{ messageId: 'utility' }, { messageId: 'utility' }],
    },
    { code: 'const s = { marginLeft: 8 };', errors: [{ messageId: 'property' }] },
    { code: 'const s = { textAlign: "left" };', errors: [{ messageId: 'textAlign' }] },
  ],
});

tester.run('sm/design-tokens', designTokens, {
  valid: [
    'const c = "bg-surface text-primary text-body-sm";',
    'const s = { color: "var(--text-primary)", fontSize: "var(--font-body)" };',
    'const id = "item#12";',
  ],
  invalid: [
    { code: 'const c = "#117567";', errors: [{ messageId: 'colour' }] },
    { code: 'const c = "bg-[#fff]";', errors: [{ messageId: 'colour' }] },
    { code: 'const c = "rgba(0,0,0,.5)";', errors: [{ messageId: 'colour' }] },
    { code: 'const c = "text-[13px]";', errors: [{ messageId: 'fontSize' }] },
    { code: 'const s = { fontSize: 13 };', errors: [{ messageId: 'fontSize' }] },
    { code: 'const s = { fontSize: "14px" };', errors: [{ messageId: 'fontSize' }] },
  ],
});
