import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { duplicateRoutes, DuplicateCheckRequest } from '@sm/contracts';
import { withTenant, type CellPrisma, type TenantContext } from '@sm/db';
import { ZodPipe } from '@sm/server-kit';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentTenant, TenantContextGuard } from '../tenancy/tenant-context.guard.js';
import { PRISMA } from '../tokens.js';
import { DuplicatesService } from './duplicates.service.js';
import { RecordContextService } from './record-context.service.js';
import { translating } from './record-errors.js';

const ObjectParam = duplicateRoutes.checkDuplicates.request.params;
const RecordParam = duplicateRoutes.listRecordDuplicates.request.params;

/** The duplicate panel while typing and on record pages (§7.2, §7.5). */
@Controller('v1/records/:object')
@UseGuards(AuthGuard, TenantContextGuard)
export class DuplicatesController {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly contexts: RecordContextService,
    private readonly duplicates: DuplicatesService,
  ) {}

  @Post('duplicates/check')
  @HttpCode(200)
  check(
    @CurrentTenant() t: TenantContext,
    @Req() request: FastifyRequest,
    @Param(new ZodPipe(ObjectParam)) p: z.infer<typeof ObjectParam>,
    @Body(new ZodPipe(DuplicateCheckRequest)) body: z.infer<typeof DuplicateCheckRequest>,
  ) {
    return withTenant(this.prisma, t, async (tx) =>
      translating(async () =>
        this.duplicates.check(tx, await this.contexts.forCaller(tx, request.id), p.object, body),
      ),
    );
  }

  @Get(':id/duplicates')
  potential(
    @CurrentTenant() t: TenantContext,
    @Req() request: FastifyRequest,
    @Param(new ZodPipe(RecordParam)) p: z.infer<typeof RecordParam>,
  ) {
    return withTenant(this.prisma, t, async (tx) =>
      translating(async () =>
        this.duplicates.potential(
          tx,
          await this.contexts.forCaller(tx, request.id),
          p.object,
          p.id,
        ),
      ),
    );
  }
}
