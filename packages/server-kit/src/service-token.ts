import { randomUUID } from 'node:crypto';

import { importPKCS8, importSPKI, jwtVerify, SignJWT, type CryptoKey, type KeyObject } from 'jose';

/**
 * Service-to-service tokens between a cell and the control plane: EdDSA (Ed25519) JWTs with a
 * 60-second lifetime. The issuer is the cell id, so the control plane knows which cell is
 * calling, and only acts on tenants that live in that cell.
 */
export const SERVICE_TOKEN_AUDIENCE = 'sm-control-plane';

export type SigningKey = CryptoKey | KeyObject;

export async function importEd25519PrivateKey(pem: string): Promise<SigningKey> {
  return importPKCS8(pem, 'EdDSA');
}

export async function importEd25519PublicKey(pem: string): Promise<SigningKey> {
  return importSPKI(pem, 'EdDSA');
}

export async function signServiceToken(
  privateKey: SigningKey,
  options: { cellId: string; kid: string; audience?: string; ttlSeconds?: number },
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'EdDSA', kid: options.kid, typ: 'sm-service+jwt' })
    .setIssuer(options.cellId)
    .setAudience(options.audience ?? SERVICE_TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${String(options.ttlSeconds ?? 60)}s`)
    .setJti(randomUUID())
    .sign(privateKey);
}

/**
 * Verify a service token. `keyForIssuer` returns the registered public key of the calling cell,
 * or undefined for an unknown cell (which fails verification).
 */
export async function verifyServiceToken(
  token: string,
  keyForIssuer: (cellId: string) => Promise<SigningKey | undefined>,
  audience = SERVICE_TOKEN_AUDIENCE,
): Promise<{ cellId: string }> {
  const [, payloadPart] = token.split('.');
  const unverified = JSON.parse(
    Buffer.from(payloadPart ?? '', 'base64url').toString('utf8') || '{}',
  ) as { iss?: unknown };
  if (typeof unverified.iss !== 'string') throw new Error('service token has no issuer');
  const key = await keyForIssuer(unverified.iss);
  if (!key) throw new Error('service token issuer is not a registered cell');
  const { payload } = await jwtVerify(token, key, {
    algorithms: ['EdDSA'],
    audience,
    issuer: unverified.iss,
    typ: 'sm-service+jwt',
    maxTokenAge: '5m',
  });
  return { cellId: String(payload.iss) };
}
