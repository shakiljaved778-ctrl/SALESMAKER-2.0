import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';

import type { ControlPlanePrisma } from '../prisma.js';
import { PRISMA, REDIS } from '../tokens.js';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(PRISMA) private readonly prisma: ControlPlanePrisma,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get()
  health() {
    return { status: 'ok' as const, service: 'control-api', cell: 'global' };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
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
    return {
      status: ready ? ('ready' as const) : ('degraded' as const),
      checks: { database, cache },
    };
  }
}
