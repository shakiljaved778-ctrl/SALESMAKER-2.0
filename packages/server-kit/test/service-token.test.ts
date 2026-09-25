import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  emailRoutingHmac,
  importEd25519PrivateKey,
  importEd25519PublicKey,
  signServiceToken,
  verifyServiceToken,
} from '../src/index.js';

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

describe('service tokens', () => {
  const eu = keyPair();
  const me = keyPair();

  it('verifies a token from a registered cell and reports the issuing cell', async () => {
    const token = await signServiceToken(await importEd25519PrivateKey(eu.privatePem), {
      cellId: 'eu-central-1',
      kid: 'k1',
    });
    const pub = await importEd25519PublicKey(eu.publicPem);
    await expect(
      verifyServiceToken(token, (id) => Promise.resolve(id === 'eu-central-1' ? pub : undefined)),
    ).resolves.toEqual({
      cellId: 'eu-central-1',
    });
  });

  it('rejects a token signed by another cell’s key under a spoofed issuer', async () => {
    const spoofed = await signServiceToken(await importEd25519PrivateKey(me.privatePem), {
      cellId: 'eu-central-1',
      kid: 'k1',
    });
    const euPub = await importEd25519PublicKey(eu.publicPem);
    await expect(verifyServiceToken(spoofed, () => Promise.resolve(euPub))).rejects.toThrow();
  });

  it('rejects unknown issuers, wrong audiences and expired tokens', async () => {
    const key = await importEd25519PrivateKey(eu.privatePem);
    const pub = await importEd25519PublicKey(eu.publicPem);
    const unknown = await signServiceToken(key, { cellId: 'xx-nowhere-1', kid: 'k1' });
    await expect(verifyServiceToken(unknown, () => Promise.resolve(undefined))).rejects.toThrow(
      /registered cell/,
    );
    const otherAudience = await signServiceToken(key, {
      cellId: 'eu-central-1',
      kid: 'k1',
      audience: 'someone-else',
    });
    await expect(verifyServiceToken(otherAudience, () => Promise.resolve(pub))).rejects.toThrow();
    const expired = await signServiceToken(key, {
      cellId: 'eu-central-1',
      kid: 'k1',
      ttlSeconds: -10,
    });
    await expect(verifyServiceToken(expired, () => Promise.resolve(pub))).rejects.toThrow();
  });
});

describe('emailRoutingHmac', () => {
  const pepper = 'test-pepper-0123456789';

  it('is stable across case, whitespace and Unicode compatibility forms', () => {
    const a = emailRoutingHmac('Jane.Doe@Example.com', pepper);
    expect(emailRoutingHmac('  jane.doe@example.com ', pepper).equals(a)).toBe(true);
    expect(emailRoutingHmac('ｊａｎｅ.doe@example.com', pepper).equals(a)).toBe(true);
    expect(a).toHaveLength(32);
  });

  it('differs per pepper and refuses a short pepper', () => {
    expect(
      emailRoutingHmac('a@b.io', pepper).equals(emailRoutingHmac('a@b.io', `${pepper}x`)),
    ).toBe(false);
    expect(() => emailRoutingHmac('a@b.io', 'short')).toThrow(/16 characters/);
  });
});
