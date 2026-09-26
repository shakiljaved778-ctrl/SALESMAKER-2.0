import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { controlPlaneRoutes } from '@sm/contracts';
import { errors, ZodPipe } from '@sm/server-kit';
import type { FastifyReply } from 'fastify';
import type { z } from 'zod';

import { ServiceTokenGuard } from '../auth/service-token.guard.js';
import { CellsService } from './cells.service.js';

const TenantsQuery = controlPlaneRoutes.listCellTenants.request.query;

@Controller('cp/v1/cells')
export class CellsController {
  constructor(private readonly cells: CellsService) {}

  @Get()
  async list() {
    return { cells: await this.cells.list() };
  }

  /** The calling cell's tenants: a cell never learns about another cell's tenants. */
  @Get('self/tenants')
  @UseGuards(ServiceTokenGuard)
  tenants(
    @Query(new ZodPipe(TenantsQuery)) query: z.infer<typeof TenantsQuery>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const cellId = reply.request.serviceCaller?.cellId;
    if (!cellId) throw errors.unauthenticated();
    return this.cells.tenantsOf(cellId, { after: query.after, limit: query.limit });
  }
}
