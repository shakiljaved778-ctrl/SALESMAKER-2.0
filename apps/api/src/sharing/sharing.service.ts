import { Inject, Injectable } from '@nestjs/common';
import { principalsOf, type Principals, type TenantTransaction } from '@sm/db';
import { defaultSharing, standardObject, type SharingModel } from '@sm/metadata';
import { VersionedCache } from '@sm/permissions';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { LOGGER, REDIS } from '../tokens.js';

export interface OrgWideDefaultSetting {
  sharingModel: SharingModel;
  grantHierarchy: boolean;
}

/** Org-wide defaults for a new organisation: every standard object's catalogue default (§6.3). */
export async function provisionOrgWideDefaults(tx: TenantTransaction): Promise<void> {
  await tx.prisma.orgWideDefault.createMany({
    data: Object.entries(defaultSharing()).map(([object, sharingModel]) => ({
      tenantId: tx.context.tenantId,
      object,
      sharingModel,
      grantHierarchy: true,
    })),
    skipDuplicates: true,
  });
}

/** Record-sharing inputs (§6.3, §6.4) the Query Engine and AccessService build on. */
@Injectable()
export class SharingService {
  private readonly principalCache: VersionedCache<Principals>;

  constructor(@Inject(REDIS) redis: Redis, @Inject(LOGGER) logger: Logger) {
    this.principalCache = new VersionedCache<Principals>(redis, 'principals', {
      onError: (err) => {
        logger.warn({ err }, 'principal cache unavailable; computing directly');
      },
    });
  }

  /** The object's org-wide default: its row, else the catalogue default, else PRIVATE. */
  async orgWideDefault(tx: TenantTransaction, object: string): Promise<OrgWideDefaultSetting> {
    const row = await tx.prisma.orgWideDefault.findUnique({
      where: { tenantId_object: { tenantId: tx.context.tenantId, object } },
      select: { sharingModel: true, grantHierarchy: true },
    });
    if (row) return row;
    return {
      sharingModel: standardObject(object)?.sharing.default ?? 'PRIVATE',
      grantHierarchy: true,
    };
  }

  /** The user's principal set, cached under the tenant's permVersion. */
  async principals(tx: TenantTransaction, userId: string): Promise<Principals> {
    const { tenantId } = tx.context;
    const { permVersion } = await tx.prisma.tenantSettings.findUniqueOrThrow({
      where: { tenantId },
      select: { permVersion: true },
    });
    return this.principalCache.getOrCompute(tenantId, userId, permVersion, () =>
      principalsOf(tx, userId),
    );
  }
}
