import { Controller, Get } from '@nestjs/common';

import { CellsService } from './cells.service.js';

@Controller('cp/v1/cells')
export class CellsController {
  constructor(private readonly cells: CellsService) {}

  @Get()
  async list() {
    return { cells: await this.cells.list() };
  }
}
