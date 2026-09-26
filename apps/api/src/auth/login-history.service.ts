import { Inject, Injectable } from '@nestjs/common';
import { withTenant, type CellPrisma, type TenantTransaction } from '@sm/db';
import { emailRoutingHmac } from '@sm/server-kit';

import type { ApiConfig } from '../config.js';
import { CONFIG, PRISMA } from '../tokens.js';
import type { ClientInfo } from './auth.service.js';

export type LoginMethod = 'password' | 'google' | 'microsoft' | 'otp' | 'recovery_code';
export type LoginOutcome =
  | 'SUCCESS'
  | 'MFA_REQUIRED'
  | 'INVALID_CREDENTIALS'
  | 'INVALID_CODE'
  | 'LOCKED'
  | 'EMAIL_NOT_VERIFIED'
  | 'NO_ACCOUNT';

export interface LoginEvent {
  method: LoginMethod;
  outcome: LoginOutcome;
  userId?: string | null | undefined;
  /** For attempts that name an address but no known user: stored only as its HMAC. */
  email?: string | undefined;
  sessionId?: string | undefined;
  client: ClientInfo;
}

/** Login history (§6.1, §6.7): one append-only row per sign-in attempt and outcome. */
@Injectable()
export class LoginHistoryService {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    @Inject(CONFIG) private readonly config: ApiConfig,
  ) {}

  /** Record inside an existing transaction (a successful sign-in, with its session). */
  async recordIn(tx: TenantTransaction, event: LoginEvent): Promise<void> {
    await tx.prisma.loginHistory.create({
      data: {
        tenantId: tx.context.tenantId,
        userId: event.userId ?? null,
        emailHash:
          !event.userId && event.email
            ? new Uint8Array(emailRoutingHmac(event.email, this.config.EMAIL_ROUTING_PEPPER))
            : null,
        method: event.method,
        outcome: event.outcome,
        sessionId: event.sessionId ?? null,
        ip: event.client.ip ?? null,
        userAgent: event.client.userAgent?.slice(0, 512) ?? null,
      },
    });
  }

  /** Record in its own transaction, so a failed attempt is kept although the request fails. */
  record(tenantId: string, event: LoginEvent): Promise<void> {
    return withTenant(this.prisma, { tenantId }, (tx) => this.recordIn(tx, event));
  }
}
