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
