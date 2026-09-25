import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { CellPrisma } from '@sm/db';
import type { FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import type { z } from 'zod';

import type { HealthResponse, ReadinessResponse } from '@sm/contracts';

import type { ApiConfig } from '../config.js';
import { CONFIG, PRISMA, REDIS } from '../tokens.js';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get()
  health(): z.infer<typeof HealthResponse> {
    return { status: 'ok', service: 'api', cell: this.config.CELL_ID };
  }

  @Get('ready')
  async ready(
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<z.infer<typeof ReadinessResponse>> {
    const [database, cache] = await Promise.all([
      this.prisma.$queryRaw`SELECT 1`.then(
        () => 'ok' as const,
        () => 'failing' as const,
      ),
      this.redis.ping().then(
        () => 'ok' as const,
        () => 'failing' as const,
      ),
    ]);
    const ready = database === 'ok' && cache === 'ok';
    if (!ready) void reply.status(HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ready ? 'ready' : 'degraded', checks: { database, cache } };
  }
}
