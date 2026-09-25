import { Injectable } from '@nestjs/common';
import type { TenantTransaction } from '@sm/db';

const WINDOW_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const THRESHOLD = 10;
const BASE_LOCK_MS = 15 * 60 * 1000;

export interface LockState {
  locked: boolean;
  /** Whole minutes until sign-in is allowed again (0 when not locked). */
  minutesRemaining: number;
}

/**
 * Lockout (§6.1): 10 failed sign-ins for an address within 15 minutes locks it; each further
 * lockout in the same day doubles the lock (15, 30, 60 … minutes, capped at 24 h). A successful
 * sign-in resets the count. Attempts are keyed by the email HMAC, so unknown addresses behave
 * exactly like known ones, and attempts made while locked are not recorded (the lock expires).
 */
@Injectable()
export class LockoutService {
  async state(
    { prisma }: TenantTransaction,
    emailHash: Uint8Array<ArrayBuffer>,
    now = new Date(),
  ): Promise<LockState> {
    const since = await this.countFrom(prisma, emailHash, new Date(now.getTime() - DAY_MS));
    const lock = await prisma.authAttempt.findFirst({
      where: { emailHash, lockedUntil: { gt: now }, at: { gt: since } },
      orderBy: { lockedUntil: 'desc' },
    });
    if (!lock?.lockedUntil) return { locked: false, minutesRemaining: 0 };
    return {
      locked: true,
      minutesRemaining: Math.ceil((lock.lockedUntil.getTime() - now.getTime()) / 60_000),
    };
  }

  async recordSuccess(
    { prisma, context }: TenantTransaction,
    emailHash: Uint8Array<ArrayBuffer>,
    userId: string,
    ip?: string,
  ) {
    await prisma.authAttempt.create({
      data: { tenantId: context.tenantId, emailHash, userId, ip: ip ?? null, success: true },
    });
  }

  /** Record a failure; returns the new lock state (it may have just locked). */
  async recordFailure(
    tx: TenantTransaction,
    emailHash: Uint8Array<ArrayBuffer>,
    userId: string | undefined,
    ip?: string,
    now = new Date(),
  ): Promise<LockState> {
    const { prisma, context } = tx;
    const attempt = await prisma.authAttempt.create({
      data: {
        tenantId: context.tenantId,
        emailHash,
        userId: userId ?? null,
        ip: ip ?? null,
        success: false,
        at: now,
      },
    });
    const windowStart = await this.countFrom(
      prisma,
      emailHash,
      new Date(now.getTime() - WINDOW_MS),
    );
    const failures = await prisma.authAttempt.count({
      where: { emailHash, success: false, at: { gt: windowStart } },
    });
    if (failures < THRESHOLD) return { locked: false, minutesRemaining: 0 };

    const dayStart = await this.countFrom(prisma, emailHash, new Date(now.getTime() - DAY_MS));
    const previousLocks = await prisma.authAttempt.count({
      where: { emailHash, lockedUntil: { not: null }, at: { gt: dayStart } },
    });
    const lockMs = Math.min(BASE_LOCK_MS * 2 ** previousLocks, DAY_MS);
    const lockedUntil = new Date(now.getTime() + lockMs);
    await prisma.authAttempt.update({
      where: { tenantId_id: { tenantId: context.tenantId, id: attempt.id } },
      data: { lockedUntil },
    });
    return { locked: true, minutesRemaining: Math.ceil(lockMs / 60_000) };
  }

  /** Count from the later of `floor` and the last successful sign-in. */
  private async countFrom(
    prisma: TenantTransaction['prisma'],
    emailHash: Uint8Array<ArrayBuffer>,
    floor: Date,
  ): Promise<Date> {
    const lastSuccess = await prisma.authAttempt.findFirst({
      where: { emailHash, success: true, at: { gt: floor } },
      orderBy: { at: 'desc' },
      select: { at: true },
    });
    return lastSuccess?.at ?? floor;
  }
}
