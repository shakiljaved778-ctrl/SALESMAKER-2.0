import { createHash, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { errors } from '@sm/server-kit';
import {
  importSPKI,
  jwtVerify,
  SignJWT,
  type CryptoKey,
  type JWTPayload,
  type KeyObject,
} from 'jose';

import type { ApiConfig } from '../config.js';
import { CONFIG } from '../tokens.js';

type Key = CryptoKey | KeyObject;

export type AuthMethod = 'pwd' | 'otp' | 'rec' | 'google' | 'microsoft';

export interface AccessClaims {
  tenantId: string;
  userId: string;
  sessionId: string;
  cellId: string;
  amr: AuthMethod[];
}

const ACCESS_TYP = 'sm-access+jwt';
const MFA_TYP = 'sm-mfa+jwt';
const AUDIENCE = 'sm-api';

/** Opaque refresh tokens: 256 random bits; only their SHA-256 is stored (§6.1). */
export function newRefreshToken(): { token: string; hash: Uint8Array<ArrayBuffer> } {
  const token = `smrt_${randomBytes(32).toString('base64url')}`;
  return { token, hash: sha256(token) };
}

export function newOneTimeToken(): { token: string; hash: Uint8Array<ArrayBuffer> } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

export function sha256(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(createHash('sha256').update(value, 'utf8').digest());
}

/**
 * Access tokens: EdDSA JWTs, 15 minutes, with a `kid` so keys can rotate (§6.1). The current
 * key signs; previous public keys from config still verify until their tokens have expired.
 */
@Injectable()
export class TokenService {
  private readonly signingKey: KeyObject;
  private readonly verifyKeys = new Map<string, Promise<Key>>();

  constructor(@Inject(CONFIG) private readonly config: ApiConfig) {
    this.signingKey = createPrivateKey(config.AUTH_JWT_PRIVATE_KEY_PEM);
    this.verifyKeys.set(
      config.AUTH_JWT_KID,
      Promise.resolve(createPublicKey(config.AUTH_JWT_PRIVATE_KEY_PEM)),
    );
    for (const previous of config.AUTH_JWT_PREVIOUS_KEYS) {
      this.verifyKeys.set(previous.kid, importSPKI(previous.publicKeyPem, 'EdDSA'));
    }
  }

  async issueAccessToken(
    claims: Omit<AccessClaims, 'cellId'>,
  ): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + this.config.ACCESS_TOKEN_TTL_SECONDS * 1000);
    const token = await new SignJWT({
      tid: claims.tenantId,
      sid: claims.sessionId,
      amr: claims.amr,
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: this.config.AUTH_JWT_KID, typ: ACCESS_TYP })
      .setIssuer(this.config.CELL_ID)
      .setAudience(AUDIENCE)
      .setSubject(claims.userId)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(this.signingKey);
    return { token, expiresAt };
  }

  async verifyAccessToken(token: string): Promise<AccessClaims> {
    const payload = await this.verify(token, ACCESS_TYP);
    const { tid, sid, amr } = payload as JWTPayload & {
      tid?: unknown;
      sid?: unknown;
      amr?: unknown;
    };
    if (
      typeof tid !== 'string' ||
      typeof sid !== 'string' ||
      typeof payload.sub !== 'string' ||
      !Array.isArray(amr)
    ) {
      throw errors.unauthenticated('The session token is not valid');
    }
    return {
      tenantId: tid,
      userId: payload.sub,
      sessionId: sid,
      cellId: String(payload.iss),
      amr: amr as AuthMethod[],
    };
  }

  /** Short-lived proof that the password step passed, redeemed by the MFA challenge (T11). */
  async issueMfaToken(
    tenantId: string,
    userId: string,
    amr: AuthMethod[],
  ): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const token = await new SignJWT({ tid: tenantId, amr })
      .setProtectedHeader({ alg: 'EdDSA', kid: this.config.AUTH_JWT_KID, typ: MFA_TYP })
      .setIssuer(this.config.CELL_ID)
      .setAudience(AUDIENCE)
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(this.signingKey);
    return { token, expiresAt };
  }

  async verifyMfaToken(
    token: string,
  ): Promise<{ tenantId: string; userId: string; amr: AuthMethod[] }> {
    const payload = (await this.verify(token, MFA_TYP)) as JWTPayload & {
      tid?: unknown;
      amr?: unknown;
    };
    if (
      typeof payload.tid !== 'string' ||
      typeof payload.sub !== 'string' ||
      !Array.isArray(payload.amr)
    ) {
      throw errors.unauthenticated('The sign-in step has expired. Start again.');
    }
    return { tenantId: payload.tid, userId: payload.sub, amr: payload.amr as AuthMethod[] };
  }

  private async verify(token: string, typ: string): Promise<JWTPayload> {
    try {
      const { payload } = await jwtVerify(
        token,
        async (header) => {
          const key = header.kid ? this.verifyKeys.get(header.kid) : undefined;
          if (!key) throw new Error('unknown kid');
          return key;
        },
        { algorithms: ['EdDSA'], audience: AUDIENCE, issuer: this.config.CELL_ID, typ },
      );
      return payload;
    } catch {
      throw errors.unauthenticated('The session token is not valid');
    }
  }
}
