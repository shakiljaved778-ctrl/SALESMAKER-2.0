/**
 * sm/design-tokens — feature code uses §9 tokens only: no raw hex colours and no pixel font
 * sizes (golden rule 6). Token source files are excluded in the ESLint config.
 */

const HEX_COLOUR = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/;
const RGB_FUNCTION = /\b(?:rgb|rgba|hsl|hsla|oklch)\(/;
const TAILWIND_PX_FONT = /(?:^|\s|:)text-\[\d+(?:\.\d+)?px\]/;
const PX_VALUE = /^\d+(?:\.\d+)?px$/;

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Require design tokens instead of raw colours and pixel font sizes' },
    messages: {
      colour: 'Raw colour value found; use a semantic colour token from @sm/ui (§9.2).',
      fontSize: 'Pixel font size found; use a typography token (§9.3).',
    },
    schema: [],
  },
  create(context) {
    function checkText(node, text) {
      if (HEX_COLOUR.test(text) || RGB_FUNCTION.test(text)) {
        context.report({ node, messageId: 'colour' });
      }
      if (TAILWIND_PX_FONT.test(text)) context.report({ node, messageId: 'fontSize' });
    }
    return {
      Literal(node) {
        if (typeof node.value === 'string') checkText(node, node.value);
      },
      TemplateElement(node) {
        checkText(node, node.value.cooked ?? node.value.raw);
      },
      Property(node) {
        const isFontSize =
          (node.key.type === 'Identifier' && node.key.name === 'fontSize') ||
          (node.key.type === 'Literal' && node.key.value === 'fontSize');
        if (!isFontSize) return;
        const { value } = node;
        if (
          (value.type === 'Literal' && typeof value.value === 'number') ||
          (value.type === 'Literal' &&
            typeof value.value === 'string' &&
            PX_VALUE.test(value.value))
        ) {
          context.report({ node: value, messageId: 'fontSize' });
        }
      },
    };
  },
};
