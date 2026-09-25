export interface FuzzyMatch {
  score: number;
  /** Indices into the text of the matched characters, ascending (for highlighting). */
  positions: number[];
}

function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text.charAt(i - 1);
  const ch = text.charAt(i);
  // After a separator, or a camelCase hump.
  return /[\s\-_/.:·,()]/.test(prev) || (prev === prev.toLowerCase() && ch !== ch.toLowerCase());
}

/**
 * Case-insensitive subsequence match for the command palette (§9.10). Contiguous runs, word
 * starts and an early first match score higher, so "cl" ranks "Create lead" and "Close" above
 * "Cancel". Returns null when the query's characters don't all appear in order. Typo tolerance
 * belongs to the search engine (M25), not here.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, positions: [] };
  const t = text.toLowerCase();
  if (t.length !== text.length) return null; // Lower-casing changed the length; don't guess indices.

  // A contiguous substring at a word start is the strongest signal.
  let best: FuzzyMatch | null = null;
  for (let from = t.indexOf(q); from !== -1; from = t.indexOf(q, from + 1)) {
    const score = 100 + (isWordStart(text, from) ? 50 : 0) - from;
    if (!best || score > best.score) {
      best = { score, positions: Array.from({ length: q.length }, (_, k) => from + k) };
    }
  }
  if (best) return best;

  // Otherwise a subsequence. Jumping to word starts reads better but can strand later
  // characters, so also try plain leftmost matching and keep the better result.
  const preferred = subsequence(q, text, t, true);
  const leftmost = subsequence(q, text, t, false);
  if (!preferred) return leftmost;
  if (!leftmost) return preferred;
  return preferred.score >= leftmost.score ? preferred : leftmost;
}

function subsequence(
  q: string,
  text: string,
  t: string,
  preferWordStart: boolean,
): FuzzyMatch | null {
  const positions: number[] = [];
  let score = 0;
  let cursor = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    let at = -1;
    for (let i = cursor; i < t.length; i++) {
      if (t.charAt(i) !== ch) continue;
      if (at === -1) at = i;
      if (!preferWordStart || isWordStart(text, i)) {
        at = i;
        break;
      }
    }
    if (at === -1) return null;
    const previous = positions.at(-1);
    score += 1;
    if (previous !== undefined && at === previous + 1) score += 5;
    if (isWordStart(text, at)) score += 8;
    if (previous !== undefined) score -= Math.min(at - previous - 1, 10) * 0.2;
    positions.push(at);
    cursor = at + 1;
  }
  if (positions[0] === 0) score += 10;
  return { score, positions };
}
