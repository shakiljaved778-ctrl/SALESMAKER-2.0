import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
  audit,
  withTenant,
  type CellPrisma,
  type TenantContext,
  type TenantTransaction,
} from '@sm/db';
import { DomainError, emailRoutingHmac, errors, type SecretBox } from '@sm/server-kit';
import { generateSecret, generateURI, verify } from 'otplib';

import type { ApiConfig } from '../config.js';
import { CONFIG, PRISMA, SECRET_BOX } from '../tokens.js';
import { AuthService, type ClientInfo, type LoginResult } from './auth.service.js';
import { LockoutService } from './lockout.service.js';
import { LoginHistoryService } from './login-history.service.js';
import { SessionService } from './session.service.js';
import { TokenService, type AuthMethod } from './token.service.js';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** 10 single-use recovery codes like `k7qm-2xpd` (40 bits each), stored as SHA-256 hashes. */
function newRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => {
    const bytes = randomBytes(8);
    const chars = [...bytes].map((b) => BASE32[b % 32] ?? 'a').join('');
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
  });
}

const hashCode = (code: string) =>
  new Uint8Array(createHash('sha256').update(code.toLowerCase(), 'utf8').digest());
const aad = (tenantId: string, factorId: string) => `mfa_factor:${tenantId}:${factorId}`;

const invalidCode = () =>
  new DomainError('validation_failed', 400, "That code didn't work", [
    {
      field: 'code',
      code: 'invalid_code',
      message: "That code didn't work. Codes change every 30 seconds, so try the latest one.",
    },
  ]);

/**
 * TOTP two-step verification (§6.1): RFC 6238 via otplib, one time step of clock drift allowed,
 * each code accepted at most once (the last used step is stored), secrets encrypted at rest,
 * and failed codes count towards a per-user lockout.
 */
@Injectable()
export class MfaService {
  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    @Inject(SECRET_BOX) private readonly box: SecretBox,
    private readonly auth: AuthService,
    private readonly lockout: LockoutService,
    private readonly sessions: SessionService,
    private readonly tokens: TokenService,
    private readonly history: LoginHistoryService,
  ) {}

  async enroll(
    ctx: TenantContext,
  ): Promise<{ factorId: string; otpauthUri: string; secret: string }> {
    const userId = ctx.userId ?? '';
    return withTenant(this.prisma, ctx, async ({ prisma }) => {
      const user = await prisma.user.findUnique({
        where: { tenantId_id: { tenantId: ctx.tenantId, id: userId } },
        include: { mfaFactors: true },
      });
      if (!user) throw errors.notFound('User');
      if (user.mfaFactors.some((f) => f.confirmedAt))
        throw errors.conflict('Two-step verification is already on');
      await prisma.mfaFactor.deleteMany({ where: { userId, confirmedAt: null } });

      const secret = generateSecret();
      const factor = await prisma.mfaFactor.create({
        data: { tenantId: ctx.tenantId, userId, type: 'totp', secretEnc: 'pending' },
      });
      await prisma.mfaFactor.update({
        where: { tenantId_id: { tenantId: ctx.tenantId, id: factor.id } },
        data: { secretEnc: this.box.seal(secret, aad(ctx.tenantId, factor.id)) },
      });
      const settings = await prisma.tenantSettings.findUnique({
        where: { tenantId: ctx.tenantId },
      });
      const otpauthUri = generateURI({
        issuer: `SalesMaker (${settings?.name ?? 'workspace'})`,
        label: user.email,
        secret,
      });
      return { factorId: factor.id, otpauthUri, secret };
    });
  }

  async confirm(ctx: TenantContext, code: string): Promise<{ recoveryCodes: string[] }> {
    const userId = ctx.userId ?? '';
    const result = await withTenant(this.prisma, ctx, async (tx) => {
      const factor = await tx.prisma.mfaFactor.findFirst({
        where: { userId, confirmedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      if (!factor) throw errors.notFound('Pending two-step verification setup');
      const step = await this.check(tx, factor, code);
      if (step === null) return null;
      await tx.prisma.mfaFactor.update({
        where: { tenantId_id: { tenantId: ctx.tenantId, id: factor.id } },
        data: { confirmedAt: new Date(), lastUsedStep: BigInt(step) },
      });
      await tx.prisma.mfaRecoveryCode.deleteMany({ where: { userId } });
      const recoveryCodes = newRecoveryCodes();
      await tx.prisma.mfaRecoveryCode.createMany({
        data: recoveryCodes.map((c) => ({ tenantId: ctx.tenantId, userId, codeHash: hashCode(c) })),
      });
      return { recoveryCodes };
    });
    if (!result) throw invalidCode();
    return result;
  }

  /** Second sign-in step. Failures are recorded (and committed) before the error is raised. */
  async challenge(
    tenantId: string,
    input: { mfaToken: string; code?: string; recoveryCode?: string },
    client: ClientInfo,
  ): Promise<LoginResult> {
    const pending = await this.tokens.verifyMfaToken(input.mfaToken);
    if (pending.tenantId !== tenantId)
      throw errors.unauthenticated('The sign-in step has expired. Start again.');
    const lockKey = new Uint8Array(
      emailRoutingHmac(`mfa:${pending.userId}`, this.config.EMAIL_ROUTING_PEPPER),
    );

    const outcome = await withTenant(
      this.prisma,
      { tenantId, userId: pending.userId },
      async (tx) => {
        const lock = await this.lockout.state(tx, lockKey);
        if (lock.locked) return { kind: 'locked' as const, minutes: lock.minutesRemaining };

        let method: AuthMethod | null = null;
        if (input.code) {
          const factor = await tx.prisma.mfaFactor.findFirst({
            where: { userId: pending.userId, confirmedAt: { not: null } },
          });
          const step = factor ? await this.check(tx, factor, input.code) : null;
          if (factor && step !== null) {
            await tx.prisma.mfaFactor.update({
              where: { tenantId_id: { tenantId, id: factor.id } },
              data: { lastUsedStep: BigInt(step) },
            });
            method = 'otp';
          }
        } else if (input.recoveryCode) {
          const used = await tx.prisma.mfaRecoveryCode.updateMany({
            where: { userId: pending.userId, codeHash: hashCode(input.recoveryCode), usedAt: null },
            data: { usedAt: new Date() },
          });
          if (used.count === 1) method = 'rec';
        }

        if (!method) {
          const state = await this.lockout.recordFailure(tx, lockKey, pending.userId, client.ip);
          return state.locked
            ? { kind: 'locked' as const, minutes: state.minutesRemaining }
            : { kind: 'invalid' as const };
        }
        await this.lockout.recordSuccess(tx, lockKey, pending.userId, client.ip);
        const { sessionId, tokens } = await this.sessions.startWithId(
          tx,
          pending.userId,
          [...pending.amr, method],
          client,
        );
        await this.history.recordIn(tx, {
          method: method === 'otp' ? 'otp' : 'recovery_code',
          outcome: 'SUCCESS',
          userId: pending.userId,
          sessionId,
          client,
        });
        return { kind: 'ok' as const, tokens, user: await this.auth.me(tx, pending.userId) };
      },
    );

    if (outcome.kind !== 'ok')
      await this.history.record(tenantId, {
        method: input.code ? 'otp' : 'recovery_code',
        outcome: outcome.kind === 'locked' ? 'LOCKED' : 'INVALID_CODE',
        userId: pending.userId,
        client,
      });
    if (outcome.kind === 'locked') {
      throw new DomainError(
        'account_locked',
        423,
        `Too many attempts. Try again in ${String(outcome.minutes)} minutes.`,
        undefined,
        {
          'retry-after': String(outcome.minutes * 60),
        },
      );
    }
    if (outcome.kind === 'invalid') throw invalidCode();
    return { status: 'ok', tokens: outcome.tokens, user: outcome.user };
  }

  /**
   * Prove the second factor for a sensitive change: a current TOTP code (spent, like at sign-in)
   * or an unused recovery code (spent too). Returns false when neither works.
   */
  private async prove(
    tx: TenantTransaction,
    userId: string,
    proof: { code: string } | { recoveryCode: string },
  ): Promise<boolean> {
    if ('recoveryCode' in proof) {
      const used = await tx.prisma.mfaRecoveryCode.updateMany({
        where: { userId, usedAt: null, codeHash: hashCode(proof.recoveryCode) },
        data: { usedAt: new Date() },
      });
      return used.count === 1;
    }
    const factor = await tx.prisma.mfaFactor.findFirst({
      where: { userId, confirmedAt: { not: null } },
    });
    if (!factor) return false;
    const step = await this.check(tx, factor, proof.code);
    if (step === null) return false;
    await tx.prisma.mfaFactor.update({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id: factor.id } },
      data: { lastUsedStep: BigInt(step) },
    });
    return true;
  }

  private async requireEnabled(tx: TenantTransaction, userId: string): Promise<void> {
    if (!(await tx.prisma.mfaFactor.count({ where: { userId, confirmedAt: { not: null } } })))
      throw errors.conflict('Two-step verification is not on');
  }

  /** Turn two-step verification off (§6.1), with a current code or a recovery code. */
  async disable(ctx: TenantContext, proof: { code: string } | { recoveryCode: string }) {
    const userId = ctx.userId ?? '';
    const ok = await withTenant(this.prisma, ctx, async (tx) => {
      await this.requireEnabled(tx, userId);
      if (!(await this.prove(tx, userId, proof))) return false;
      await tx.prisma.mfaFactor.deleteMany({ where: { userId } });
      await tx.prisma.mfaRecoveryCode.deleteMany({ where: { userId } });
      await audit.record(tx, { action: 'user.mfa_disabled', recordId: userId });
      return true;
    });
    if (!ok) throw invalidCode();
  }

  /** Replace every recovery code (the old ones stop working); the new ones are shown once. */
  async regenerateRecoveryCodes(
    ctx: TenantContext,
    proof: { code: string } | { recoveryCode: string },
  ): Promise<{ recoveryCodes: string[] }> {
    const userId = ctx.userId ?? '';
    const result = await withTenant(this.prisma, ctx, async (tx) => {
      await this.requireEnabled(tx, userId);
      if (!(await this.prove(tx, userId, proof))) return null;
      await tx.prisma.mfaRecoveryCode.deleteMany({ where: { userId } });
      const recoveryCodes = newRecoveryCodes();
      await tx.prisma.mfaRecoveryCode.createMany({
        data: recoveryCodes.map((c) => ({ tenantId: ctx.tenantId, userId, codeHash: hashCode(c) })),
      });
      await audit.record(tx, { action: 'user.mfa_recovery_codes_regenerated', recordId: userId });
      return { recoveryCodes };
    });
    if (!result) throw invalidCode();
    return result;
  }

  /** Returns the matched RFC 6238 time step, or null. Codes at or before the last used step fail. */
  private async check(
    { context }: TenantTransaction,
    factor: { id: string; secretEnc: string; lastUsedStep: bigint | null },
    code: string,
  ): Promise<number | null> {
    const secret = this.box.open(factor.secretEnc, aad(context.tenantId, factor.id));
    const result = await verify({
      secret,
      token: code,
      epochTolerance: 30,
      ...(factor.lastUsedStep !== null ? { afterTimeStep: Number(factor.lastUsedStep) } : {}),
    });
    return result.valid && 'timeStep' in result ? result.timeStep : null;
  }
}
