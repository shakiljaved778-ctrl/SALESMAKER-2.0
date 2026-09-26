import { Inject, Injectable } from '@nestjs/common';
import { importEd25519PublicKey, type SigningKey } from '@sm/server-kit';

import type { ControlApiConfig } from '../config.js';
import type { ControlPlanePrisma } from '../prisma.js';
import { CONFIG, PRISMA } from '../tokens.js';

@Injectable()
export class CellsService {
  private readonly keys = new Map<string, SigningKey>();

  constructor(
    @Inject(CONFIG) private readonly config: ControlApiConfig,
    @Inject(PRISMA) private readonly prisma: ControlPlanePrisma,
  ) {}

  /** Upsert configured cells and load their service-token public keys. Called at startup. */
  async sync(): Promise<void> {
    for (const cell of this.config.CELLS) {
      await this.prisma.cell.upsert({ where: { id: cell.id }, create: cell, update: cell });
      this.keys.set(cell.id, await importEd25519PublicKey(cell.publicKeyPem));
    }
  }

  publicKeyFor(cellId: string): Promise<SigningKey | undefined> {
    return Promise.resolve(this.keys.get(cellId));
  }

  /** Tenant ids hosted by a cell, in id order, one page at a time. */
  async tenantsOf(cellId: string, page: { after?: string | undefined; limit: number }) {
    const rows = await this.prisma.tenant.findMany({
      where: { cellId, ...(page.after ? { id: { gt: page.after } } : {}) },
      orderBy: { id: 'asc' },
      take: page.limit + 1,
      select: { id: true },
    });
    const tenantIds = rows.slice(0, page.limit).map((r) => r.id);
    return { tenantIds, next: rows.length > page.limit ? (tenantIds.at(-1) ?? null) : null };
  }

  async list() {
    const cells = await this.prisma.cell.findMany({ orderBy: { id: 'asc' } });
    return cells.map(({ id, region, label, apiBaseUrl, signupOpen }) => ({
      id,
      region,
      label,
      apiBaseUrl,
      signupOpen,
    }));
  }
}
