import { randomBytes } from 'node:crypto';

/*
 * Inbound address tokens (§7.1): `leads-{token}@{inbound domain}`. Mail reaches the cell before
 * it knows the workspace, and row-level security needs one before it can look anything up, so the
 * token carries the tenant id (16 bytes) and 10 random bytes, in lower-case base32 (42 characters;
 * a 48-character local part, under the 64 allowed).
 */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const TOKEN = /^[a-z2-7]{42}$/;

function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET.charAt((value << (5 - bits)) & 31);
  return out;
}

function unbase32(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new token for this tenant. */
export function newInboundToken(tenantId: string): string {
  return base32(Buffer.concat([Buffer.from(tenantId.replace(/-/g, ''), 'hex'), randomBytes(10)]));
}

/** The tenant a token belongs to (it must still match a stored address). */
export function tenantOfToken(token: string): string | null {
  if (!TOKEN.test(token)) return null;
  const hex = unbase32(token).subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const inboundAddress = (token: string, domain: string) => `leads-${token}@${domain}`;

/** The token of an address at our inbound domain (any case); null for anything else. */
export function tokenOfAddress(address: string, domain: string): string | null {
  const m = /^leads-([a-z2-7]{42})@(.+)$/.exec(address.trim().toLowerCase());
  return m?.[1] && m[2] === domain.toLowerCase() ? m[1] : null;
}
