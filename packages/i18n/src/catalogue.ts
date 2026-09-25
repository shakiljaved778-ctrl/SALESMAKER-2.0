import { parse } from '@formatjs/icu-messageformat-parser';

import { pseudoLocalise } from './pseudo.js';

export type Messages = { [key: string]: string | Messages };

const KEY_SEGMENT = /^[a-z][a-zA-Z0-9]*$/;

/** Flatten nested messages to dotted keys: `auth.signIn.title`. */
export function flatten(messages: Messages, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [segment, value] of Object.entries(messages)) {
    const key = prefix ? `${prefix}.${segment}` : segment;
    if (typeof value === 'string') out.set(key, value);
    else for (const [k, v] of flatten(value, key)) out.set(k, v);
  }
  return out;
}

export function mapMessages(messages: Messages, fn: (text: string) => string): Messages {
  return Object.fromEntries(
    Object.entries(messages).map(([k, v]) => [
      k,
      typeof v === 'string' ? fn(v) : mapMessages(v, fn),
    ]),
  );
}

export function toPseudo(messages: Messages): Messages {
  return mapMessages(messages, pseudoLocalise);
}

export interface CatalogueProblem {
  key: string;
  problem: string;
}

/**
 * The i18n key check (§13.4): every message is valid ICU, non-empty, and every key segment is
 * camelCase so keys stay namespaced and predictable (`leads.list.empty.title`).
 */
export function checkCatalogue(messages: Messages): CatalogueProblem[] {
  const problems: CatalogueProblem[] = [];
  for (const [key, text] of flatten(messages)) {
    for (const segment of key.split('.')) {
      if (!KEY_SEGMENT.test(segment))
        problems.push({ key, problem: `segment "${segment}" is not camelCase` });
    }
    if (text.trim() === '') problems.push({ key, problem: 'message is empty' });
    try {
      parse(text);
    } catch (error) {
      problems.push({ key, problem: `invalid ICU: ${(error as Error).message}` });
    }
  }
  return problems;
}
