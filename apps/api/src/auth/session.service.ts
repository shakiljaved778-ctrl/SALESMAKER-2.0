import { Inject, Injectable } from '@nestjs/common';
import type { TenantTransaction } from '@sm/db';
import { uuidv7 } from 'uuidv7';

import type { ApiConfig } from '../config.js';
import { CONFIG } from '../tokens.js';
import { newRefreshToken, sha256, TokenService, type AuthMethod } from './token.service.js';

export interface IssuedTokens {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

/**
 * Sessions and rotating refresh tokens (§6.1). Each refresh consumes the presented token and
 * issues a child in the same family with a fresh 30-day expiry (sliding). Presenting a token
 * that was already consumed means it leaked: the whole family and the session are revoked.
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    private readonly tokens: TokenService,
  ) {}

  async start(
    tx: TenantTransaction,
    userId: string,
    amr: AuthMethod[],
    client: { ip?: string | undefined; userAgent?: string | undefined },
  ): Promise<IssuedTokens> {
    const { prisma, context } = tx;
    const session = await prisma.session.create({
      data: {
        tenantId: context.tenantId,
        userId,
        ip: client.ip ?? null,
        userAgent: client.userAgent?.slice(0, 512) ?? null,
        mfaVerified: amr.includes('otp') || amr.includes('rec'),
      },
    });
    return this.issue(tx, session.id, userId, amr, uuidv7(), null);
  }

  /**
   * Returns the new tokens, or the reason the presented token was refused. Refusals are returned
   * rather than thrown so that a reuse revocation commits: throwing inside the tenant
   * transaction would roll the revocation back and leave the stolen token's family alive.
   */
  async rotate(
    tx: TenantTransaction,
    presented: string,
  ): Promise<
    { ok: true; tokens: IssuedTokens } | { ok: false; reason: 'unknown' | 'reused' | 'expired' }
  > {
    const { prisma } = tx;
    const hash = sha256(presented);
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM refresh_token WHERE token_hash = ${hash} FOR UPDATE`;
    const id = rows[0]?.id;
    const current = id
      ? await prisma.refreshToken.findUnique({
          where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
          include: { session: true },
        })
      : null;
    if (!current) return { ok: false, reason: 'unknown' };

    if (current.usedAt || current.revokedAt || current.session.revokedAt) {
      await this.revokeSession(tx, current.sessionId);
      return { ok: false, reason: 'reused' };
    }
    if (current.expiresAt <= new Date()) return { ok: false, reason: 'expired' };

    await prisma.refreshToken.update({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id: current.id } },
      data: { usedAt: new Date() },
    });
    await prisma.session.update({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id: current.sessionId } },
      data: { lastSeenAt: new Date() },
    });
    const amr: AuthMethod[] = current.session.mfaVerified ? ['pwd', 'otp'] : ['pwd'];
    return {
      ok: true,
      tokens: await this.issue(
        tx,
        current.sessionId,
        current.session.userId,
        amr,
        current.familyId,
        current.id,
      ),
    };
  }

  /** End the session owning `presented`; unknown tokens are ignored (logout is idempotent). */
  async endByRefreshToken(tx: TenantTransaction, presented: string): Promise<void> {
    const token = await tx.prisma.refreshToken.findFirst({
      where: { tokenHash: sha256(presented) },
    });
    if (token) await this.revokeSession(tx, token.sessionId);
  }

  async revokeAllForUser(tx: TenantTransaction, userId: string): Promise<void> {
    const now = new Date();
    await tx.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.prisma.refreshToken.updateMany({
      where: { session: { userId }, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  private async revokeSession(tx: TenantTransaction, sessionId: string): Promise<void> {
    const now = new Date();
    await tx.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.prisma.refreshToken.updateMany({
      where: { sessionId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  private async issue(
    { prisma, context }: TenantTransaction,
    sessionId: string,
    userId: string,
    amr: AuthMethod[],
    familyId: string,
    parentId: string | null,
  ): Promise<IssuedTokens> {
    const refresh = newRefreshToken();
    const refreshExpiresAt = new Date(Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
    await prisma.refreshToken.create({
      data: {
        tenantId: context.tenantId,
        sessionId,
        familyId,
        parentId,
        tokenHash: refresh.hash,
        expiresAt: refreshExpiresAt,
      },
    });
    const access = await this.tokens.issueAccessToken({
      tenantId: context.tenantId,
      userId,
      sessionId,
      amr,
    });
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken: refresh.token,
      refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
    };
  }
}
