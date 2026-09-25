/**
 * sm/logical-css — bans physical-direction styling so Arabic RTL needs no refactor (§9.12).
 * Flags Tailwind physical utilities in string/template literals and physical CSS properties
 * in style objects. Use ms-/me-/ps-/pe-/start-/end-/text-start/border-s/rounded-s-* instead.
 */

const PHYSICAL_UTILITY =
  /^(?:(?:m|p|scroll-m|scroll-p)[lr]-.+|(?:left|right)-.+|border-[lr](?:-.+)?|rounded-(?:[lr]|tl|tr|bl|br)(?:-.+)?|text-(?:left|right)|float-(?:left|right)|clear-(?:left|right))$/;

const PHYSICAL_PROPERTY =
  /^(?:(?:margin|padding|border|scrollMargin|scrollPadding)(?:Left|Right)|left|right)(?:Width|Style|Color|Radius)?$/;

const LOGICAL_HINT = {
  ml: 'ms',
  mr: 'me',
  pl: 'ps',
  pr: 'pe',
  left: 'start',
  right: 'end',
  'text-left': 'text-start',
  'text-right': 'text-end',
  'border-l': 'border-s',
  'border-r': 'border-e',
};

/** Strip Tailwind variants (`hover:`, `md:`, `rtl:`), the important flag and a negative sign. */
function baseUtility(token) {
  const withoutVariants = token.slice(token.lastIndexOf(':') + 1);
  return withoutVariants.replace(/^!/, '').replace(/^-/, '');
}

export function findPhysicalUtilities(text) {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => PHYSICAL_UTILITY.test(baseUtility(token)));
}

function hintFor(token) {
  const base = baseUtility(token);
  for (const [physical, logical] of Object.entries(LOGICAL_HINT)) {
    if (base === physical || base.startsWith(`${physical}-`)) return logical;
  }
  return 'a logical equivalent';
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Require logical (RTL-safe) CSS utilities and properties' },
    messages: {
      utility: "Physical utility '{{token}}' is not RTL-safe; use {{hint}} (§9.12).",
      property:
        "Physical style property '{{name}}' is not RTL-safe; use the inline-start/end equivalent (§9.12).",
      textAlign: "textAlign '{{value}}' is not RTL-safe; use 'start' or 'end' (§9.12).",
    },
    schema: [],
  },
  create(context) {
    function checkText(node, text) {
      for (const token of findPhysicalUtilities(text)) {
        context.report({ node, messageId: 'utility', data: { token, hint: hintFor(token) } });
      }
    }
    return {
      Literal(node) {
        if (typeof node.value === 'string') checkText(node, node.value);
      },
      TemplateElement(node) {
        checkText(node, node.value.cooked ?? node.value.raw);
      },
      Property(node) {
        const name =
          node.key.type === 'Identifier'
            ? node.key.name
            : node.key.type === 'Literal' && typeof node.key.value === 'string'
              ? node.key.value
              : undefined;
        if (!name) return;
        if (PHYSICAL_PROPERTY.test(name)) {
          context.report({ node: node.key, messageId: 'property', data: { name } });
        }
        if (
          name === 'textAlign' &&
          node.value.type === 'Literal' &&
          (node.value.value === 'left' || node.value.value === 'right')
        ) {
          context.report({
            node: node.value,
            messageId: 'textAlign',
            data: { value: node.value.value },
          });
        }
      },
    };
  },
};
