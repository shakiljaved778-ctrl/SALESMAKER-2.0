import { Injectable } from '@nestjs/common';
import type { TenantTransaction } from '@sm/db';
import { loadRecordContext, type RecordContext } from '@sm/records';

import { MetadataService } from '../metadata/metadata.service.js';
import { PermissionService } from '../permissions/permission.service.js';
import { SharingService } from '../sharing/sharing.service.js';

/**
 * The RecordContext for a request: the caller's cached permissions and principals and the
 * tenant's cached metadata, everything else loaded in the request's transaction.
 */
@Injectable()
export class RecordContextService {
  constructor(
    private readonly permissions: PermissionService,
    private readonly sharing: SharingService,
    private readonly metadata: MetadataService,
  ) {}

  async forCaller(tx: TenantTransaction, requestId?: string): Promise<RecordContext> {
    const userId = tx.context.userId;
    if (!userId) throw new Error('a record context needs a user');
    const [permissions, principals, metadata] = [
      await this.permissions.forUser(tx, userId),
      await this.sharing.principals(tx, userId),
      await this.metadata.forTenant(tx),
    ];
    return loadRecordContext(tx, userId, {
      permissions,
      principals,
      metadata,
      ...(requestId ? { requestId } : {}),
    });
  }
}
