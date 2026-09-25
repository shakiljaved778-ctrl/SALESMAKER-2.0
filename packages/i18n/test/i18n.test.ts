import { describe, expect, it } from 'vitest';

import en from '../messages/en.json' with { type: 'json' };
import { checkCatalogue, directionOf, pseudoLocalise, serverTranslator } from '../src/index.js';

describe('pseudoLocalise (en-XA)', () => {
  it('accents literals, keeps placeholders and pads by ~30%', () => {
    const out = pseudoLocalise('Sign in to {workspace}');
    expect(out).toMatch(/^［Šíĝñ íñ ţó \{workspace\}·+］$/);
    expect(out.length).toBeGreaterThan('Sign in to {workspace}'.length * 1.2);
  });

  it('keeps plural and select structure intact', () => {
    const out = pseudoLocalise('{n, plural, one {# minute} other {# minutes}}');
    expect(out).toContain('{n,plural,one{# ɱíñúţé} other{# ɱíñúţéš}}');
  });
});

describe('checkCatalogue', () => {
  it('passes on the shipped English catalogue', () => {
    expect(checkCatalogue(en)).toEqual([]);
  });

  it('flags bad key segments, empty messages and invalid ICU', () => {
    const problems = checkCatalogue({
      Bad_Key: 'x',
      ok: { empty: ' ', broken: '{count, plural, one {x}' },
    });
    expect(problems.map((p) => p.key)).toEqual(['Bad_Key', 'ok.empty', 'ok.broken']);
  });
});

describe('serverTranslator', () => {
  it('formats ICU plurals from the catalogue', () => {
    const t = serverTranslator('en');
    expect(t('auth.errors.locked', { minutes: 1 })).toBe(
      'Too many attempts. Wait 1 minute and try again.',
    );
    expect(t('auth.errors.locked', { minutes: 15 })).toBe(
      'Too many attempts. Wait 15 minutes and try again.',
    );
  });

  it('serves the pseudo-locale and falls back to English for unknown locales', () => {
    expect(serverTranslator('en-XA')('common.actions.save')).toBe('［Šáṽé··］');
    expect(serverTranslator('ar-XB')('common.actions.save')).toBe('Save');
    expect(serverTranslator('xx')('common.actions.save')).toBe('Save');
  });
});

describe('directionOf', () => {
  it('maps RTL languages, including the ar-XB pseudo-locale', () => {
    expect(directionOf('ar-XB')).toBe('rtl');
    expect(directionOf('ar')).toBe('rtl');
    expect(directionOf('en')).toBe('ltr');
    expect(directionOf('en-XA')).toBe('ltr');
  });
});
