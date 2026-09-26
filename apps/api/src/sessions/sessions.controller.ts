import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  cursorPage,
  LoginHistoryEntry,
  LoginHistoryQuery,
  PageQuery,
  sessionRoutes,
} from '@sm/contracts';
import { audit, withTenant, type CellPrisma, type TenantTransaction } from '@sm/db';
import { errors, ZodPipe } from '@sm/server-kit';
import type { z } from 'zod';

import {
  RequireSystemPermission,
  SystemPermissionGuard,
} from '../access/system-permission.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { SessionService } from '../auth/session.service.js';
import {
  CurrentCaller,
  TenantContextGuard,
  type VerifiedCaller,
} from '../tenancy/tenant-context.guard.js';
import { PRISMA } from '../tokens.js';

const IdParam = sessionRoutes.revokeMySession.request.params;
const HistoryPage = cursorPage(LoginHistoryEntry);
type HistoryPage = z.infer<typeof HistoryPage>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function historyPage(
  tx: TenantTransaction,
  q: { limit: number; cursor?: string | undefined },
  where: { userId?: string; outcome?: z.infer<typeof LoginHistoryQuery>['outcome'] },
): Promise<HistoryPage> {
  if (q.cursor && !UUID.test(q.cursor))
    throw errors.validation([{ field: 'cursor', code: 'invalid', message: 'Invalid cursor' }]);
  const rows = await tx.prisma.loginHistory.findMany({
    where: {
      ...(q.cursor ? { id: { lt: q.cursor } } : {}),
      ...(where.userId ? { userId: where.userId } : {}),
      ...(where.outcome ? { outcome: where.outcome } : {}),
    },
    orderBy: { id: 'desc' },
    take: q.limit + 1,
  });
  const page = rows.slice(0, q.limit);
  return {
    items: page.map((r) => ({
      id: r.id,
      occurredAt: r.occurredAt.toISOString(),
      userId: r.userId,
      method: r.method,
      outcome: r.outcome,
      sessionId: r.sessionId,
      ip: r.ip,
      userAgent: r.userAgent,
    })),
    nextCursor: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

const ctx = (caller: VerifiedCaller) => ({ tenantId: caller.tenantId, userId: caller.userId });

/** The caller's sessions and sign-ins (§6.1): the device list and remote sign-out. */
@Controller('v1/me')
@UseGuards(AuthGuard, TenantContextGuard)
export class MySessionsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly sessions: SessionService,
  ) {}

  @Get('sessions')
  list(@CurrentCaller() caller: VerifiedCaller) {
    return withTenant(this.prisma, ctx(caller), async (tx) => {
      const rows = await tx.prisma.session.findMany({
        where: {
          userId: caller.userId,
          revokedAt: null,
          refreshTokens: { some: { revokedAt: null, usedAt: null, expiresAt: { gt: new Date() } } },
        },
        orderBy: { lastSeenAt: 'desc' },
      });
      return {
        items: rows.map((s) => ({
          id: s.id,
          createdAt: s.createdAt.toISOString(),
          lastSeenAt: s.lastSeenAt.toISOString(),
          ip: s.ip,
          userAgent: s.userAgent,
          mfaVerified: s.mfaVerified,
          current: s.id === caller.sessionId,
        })),
      };
    });
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async revoke(
    @CurrentCaller() caller: VerifiedCaller,
    @Param(new ZodPipe(IdParam)) params: z.infer<typeof IdParam>,
  ): Promise<void> {
    await withTenant(this.prisma, ctx(caller), async (tx) => {
      if (!(await this.sessions.revokeForUser(tx, caller.userId, params.id)))
        throw errors.notFound('Session');
      await audit.record(tx, { action: 'session.revoked', payload: { sessionId: params.id } });
    });
  }

  @Post('sessions/revoke-others')
  @HttpCode(200)
  revokeOthers(@CurrentCaller() caller: VerifiedCaller) {
    return withTenant(this.prisma, ctx(caller), async (tx) => {
      const revoked = await this.sessions.revokeAllForUser(tx, caller.userId, caller.sessionId);
      await audit.record(tx, { action: 'session.revoked_others', payload: { revoked } });
      return { revoked };
    });
  }

  @Get('login-history')
  myHistory(
    @CurrentCaller() caller: VerifiedCaller,
    @Query(new ZodPipe(PageQuery)) q: z.infer<typeof PageQuery>,
  ): Promise<HistoryPage> {
    return withTenant(this.prisma, ctx(caller), (tx) =>
      historyPage(tx, q, { userId: caller.userId }),
    );
  }
}

/** Workspace login history (§6.7, Setup). */
@Controller('v1/login-history')
@UseGuards(AuthGuard, TenantContextGuard, SystemPermissionGuard)
@RequireSystemPermission('view_setup')
export class LoginHistoryController {
  constructor(@Inject(PRISMA) private readonly prisma: CellPrisma) {}

  @Get()
  list(
    @CurrentCaller() caller: VerifiedCaller,
    @Query(new ZodPipe(LoginHistoryQuery)) q: z.infer<typeof LoginHistoryQuery>,
  ): Promise<HistoryPage> {
    return withTenant(this.prisma, ctx(caller), (tx) =>
      historyPage(tx, q, {
        ...(q.userId ? { userId: q.userId } : {}),
        ...(q.outcome ? { outcome: q.outcome } : {}),
      }),
    );
  }
}
