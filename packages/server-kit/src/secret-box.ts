import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Application-level envelope encryption for secrets at rest (§6.6): OAuth tokens, TOTP
 * secrets, SSO certificates. AES-256-GCM with a random 96-bit IV; the ciphertext is stored as
 * `<keyId>:<base64url(iv ‖ tag ‖ ciphertext)>` so keys can rotate: new writes use the current
 * key, and reads accept any key still in the ring. Locally the key comes from config; deployed
 * cells take data keys from KMS (a KMS-backed key ring drops in behind the same interface).
 */
export class SecretBox {
  private readonly keys: Map<string, Buffer>;

  constructor(
    private readonly currentKeyId: string,
    keys: Record<string, string>,
  ) {
    this.keys = new Map(Object.entries(keys).map(([id, b64]) => [id, Buffer.from(b64, 'base64')]));
    for (const [id, key] of this.keys) {
      if (key.length !== 32) throw new Error(`secret key ${id} must be 32 bytes (base64-encoded)`);
      if (id.includes(':')) throw new Error(`secret key id ${id} must not contain ':'`);
    }
    if (!this.keys.has(currentKeyId))
      throw new Error(`current secret key ${currentKeyId} is not in the key ring`);
  }

  seal(plaintext: string, associatedData = ''): string {
    const key = this.keys.get(this.currentKeyId);
    if (!key) throw new Error('no current key');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `${this.currentKeyId}:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')}`;
  }

  open(sealed: string, associatedData = ''): string {
    const separator = sealed.indexOf(':');
    const key = this.keys.get(sealed.slice(0, separator));
    if (separator < 1 || !key) throw new Error('sealed secret uses an unknown key');
    const raw = Buffer.from(sealed.slice(separator + 1), 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
}
