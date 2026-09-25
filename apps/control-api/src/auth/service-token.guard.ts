import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { errors, verifyServiceToken } from '@sm/server-kit';
import type { FastifyRequest } from 'fastify';

import { CellsService } from '../cells/cells.service.js';

declare module 'fastify' {
  interface FastifyRequest {
    serviceCaller?: { cellId: string };
  }
}

/** Only registered cells may call service routes; the verified issuer becomes `serviceCaller`. */
@Injectable()
export class ServiceTokenGuard implements CanActivate {
  constructor(private readonly cells: CellsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!token) throw errors.unauthenticated('A service token is required');
    try {
      request.serviceCaller = await verifyServiceToken(token, (cellId) =>
        this.cells.publicKeyFor(cellId),
      );
    } catch {
      throw errors.unauthenticated('The service token is not valid');
    }
    return true;
  }
}
