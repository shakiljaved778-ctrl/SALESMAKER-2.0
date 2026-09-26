import {
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { withTenant, type CellPrisma } from '@sm/db';
import type { SystemPermissionName } from '@sm/permissions';
import { errors } from '@sm/server-kit';
import type { FastifyRequest } from 'fastify';

import { PRISMA } from '../tokens.js';
import { AccessService } from './access.service.js';

const SYSTEM_PERMISSIONS_KEY = 'sm:system-permissions';

/**
 * Require every listed system permission (§6.2 layer 2) on a route or controller. Runs after
 * AuthGuard and TenantContextGuard; a caller without them gets 403.
 */
export const RequireSystemPermission = (...names: SystemPermissionName[]) =>
  SetMetadata(SYSTEM_PERMISSIONS_KEY, names);

@Injectable()
export class SystemPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: AccessService,
    @Inject(PRISMA) private readonly prisma: CellPrisma,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required =
      this.reflector.getAllAndOverride<SystemPermissionName[] | undefined>(SYSTEM_PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (required.length === 0) return true;
    const caller = context.switchToHttp().getRequest<FastifyRequest>().caller;
    if (!caller) throw errors.unauthenticated();
    await withTenant(
      this.prisma,
      { tenantId: caller.tenantId, userId: caller.userId },
      async (tx) => {
        for (const name of required)
          await this.access.requireSystemPermission(tx, caller.userId, name);
      },
    );
    return true;
  }
}
