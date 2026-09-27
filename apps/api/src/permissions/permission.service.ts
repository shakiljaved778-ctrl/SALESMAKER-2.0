import { Inject, Injectable } from '@nestjs/common';
import type { TenantTransaction } from '@sm/db';
import { effectivePermissions, PermissionCache, type EffectivePermissions } from '@sm/permissions';
import { loadPermissionSource } from '@sm/records';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { LOGGER, REDIS } from '../tokens.js';

export { loadPermissionSource, toGrants } from '@sm/records';

/** Effective permissions per user (§6.2), cached in Valkey under the tenant's permVersion. */
@Injectable()
export class PermissionService {
  private readonly cache: PermissionCache;

  constructor(@Inject(REDIS) redis: Redis, @Inject(LOGGER) logger: Logger) {
    this.cache = new PermissionCache(redis, 3600, (err) => {
      logger.warn({ err }, 'permission cache unavailable; computing directly');
    });
  }

  async forUser(tx: TenantTransaction, userId: string): Promise<EffectivePermissions> {
    const { tenantId } = tx.context;
    // Read the version first: data read afterwards is never older than the key it is stored under.
    const { permVersion } = await tx.prisma.tenantSettings.findUniqueOrThrow({
      where: { tenantId },
      select: { permVersion: true },
    });
    return this.cache.getOrCompute(tenantId, userId, permVersion, async () =>
      effectivePermissions(await loadPermissionSource(tx, userId)),
    );
  }
}
