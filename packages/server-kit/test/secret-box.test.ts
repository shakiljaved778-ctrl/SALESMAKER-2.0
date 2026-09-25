import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { SecretBox } from '../src/index.js';

const k1 = randomBytes(32).toString('base64');
const k2 = randomBytes(32).toString('base64');

describe('SecretBox (§6.6)', () => {
  it('round-trips and never repeats ciphertext for the same plaintext', () => {
    const box = new SecretBox('k1', { k1 });
    const a = box.seal('JBSWY3DPEHPK3PXP', 'mfa_factor:1');
    const b = box.seal('JBSWY3DPEHPK3PXP', 'mfa_factor:1');
    expect(a).not.toBe(b);
    expect(a.startsWith('k1:')).toBe(true);
    expect(box.open(a, 'mfa_factor:1')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('binds the ciphertext to its associated data and detects tampering', () => {
    const box = new SecretBox('k1', { k1 });
    const sealed = box.seal('secret', 'row-a');
    expect(() => box.open(sealed, 'row-b')).toThrow();
    const tampered = `${sealed.slice(0, -2)}${sealed.endsWith('A') ? 'B' : 'A'}A`;
    expect(() => box.open(tampered, 'row-a')).toThrow();
  });

  it('rotates keys: old ciphertext opens while new writes use the current key', () => {
    const old = new SecretBox('k1', { k1 }).seal('secret');
    const rotated = new SecretBox('k2', { k1, k2 });
    expect(rotated.open(old)).toBe('secret');
    expect(rotated.seal('secret').startsWith('k2:')).toBe(true);
    expect(() => new SecretBox('k2', { k2 }).open(old)).toThrow(/unknown key/);
  });

  it('rejects bad key material', () => {
    expect(() => new SecretBox('k1', { k1: 'c2hvcnQ=' })).toThrow(/32 bytes/);
    expect(() => new SecretBox('k9', { k1 })).toThrow(/not in the key ring/);
  });
});
