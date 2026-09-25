import { Controller, Get } from '@nestjs/common';
import { buildOpenApiDocument } from '@sm/contracts';

import { API_INFO, apiRoutes } from './routes.js';

@Controller('v1')
export class OpenApiController {
  private readonly document = buildOpenApiDocument(
    apiRoutes.filter((r) => r.visibility === 'public-api'),
    API_INFO,
  );

  @Get('openapi.json')
  openapi(): Record<string, unknown> {
    return this.document;
  }
}
