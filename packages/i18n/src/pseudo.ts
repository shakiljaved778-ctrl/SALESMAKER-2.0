import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { printAST } from '@formatjs/icu-messageformat-parser/printer.js';

const ACCENTS: Record<string, string> = {
  a: 'á',
  b: 'ƀ',
  c: 'ç',
  d: 'ð',
  e: 'é',
  f: 'ƒ',
  g: 'ĝ',
  h: 'ĥ',
  i: 'í',
  j: 'ĵ',
  k: 'ķ',
  l: 'ļ',
  m: 'ɱ',
  n: 'ñ',
  o: 'ó',
  p: 'þ',
  q: 'ǫ',
  r: 'ŕ',
  s: 'š',
  t: 'ţ',
  u: 'ú',
  v: 'ṽ',
  w: 'ŵ',
  x: 'ẋ',
  y: 'ý',
  z: 'ž',
  A: 'Á',
  B: 'Ɓ',
  C: 'Ç',
  D: 'Ð',
  E: 'É',
  F: 'Ƒ',
  G: 'Ĝ',
  H: 'Ĥ',
  I: 'Í',
  J: 'Ĵ',
  K: 'Ķ',
  L: 'Ļ',
  M: 'Ṁ',
  N: 'Ñ',
  O: 'Ó',
  P: 'Þ',
  Q: 'Ǫ',
  R: 'Ŕ',
  S: 'Š',
  T: 'Ţ',
  U: 'Ú',
  V: 'Ṽ',
  W: 'Ŵ',
  X: 'Ẋ',
  Y: 'Ý',
  Z: 'Ž',
};

function accent(text: string): string {
  return text.replace(/[A-Za-z]/g, (ch) => ACCENTS[ch] ?? ch);
}

function transform(elements: MessageFormatElement[]): MessageFormatElement[] {
  return elements.map((el) => {
    switch (el.type) {
      case TYPE.literal:
        return { ...el, value: accent(el.value) };
      case TYPE.select:
      case TYPE.plural:
        return {
          ...el,
          options: Object.fromEntries(
            Object.entries(el.options).map(([key, option]) => [
              key,
              { ...option, value: transform(option.value) },
            ]),
          ),
        };
      case TYPE.tag:
        return { ...el, children: transform(el.children) };
      default:
        return el;
    }
  });
}

/**
 * en-XA pseudo-localisation: accent every literal (placeholders, plural and select structure are
 * untouched), pad by ~30% and bracket the result so truncation and concatenation are visible.
 */
export function pseudoLocalise(message: string): string {
  const ast = transform(parse(message, { ignoreTag: false }));
  const printed = printAST(ast);
  const padding = '·'.repeat(Math.max(1, Math.ceil(message.length * 0.3)));
  return `［${printed}${padding}］`;
}
