/** Small sRGB helpers used to derive tokens and to check contrast (WCAG 2.x). */
export type Rgb = [number, number, number];

export function parseHex(hex: string): Rgb {
  const h = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`not a 6-digit hex colour: ${hex}`);
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as Rgb;
}

export function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b]
    .map((c) => Math.round(c).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;
}

/** Same result as CSS `color-mix(in srgb, a p%, b)` or `a` at alpha p over an opaque `b`. */
export function mix(a: string, weight: number, b: string): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  return toHex([
    ar * weight + br * (1 - weight),
    ag * weight + bg * (1 - weight),
    ab * weight + bb * (1 - weight),
  ]);
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
