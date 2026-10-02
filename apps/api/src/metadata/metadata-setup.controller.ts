import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  CreateFieldRequest,
  FieldParam,
  PutPicklistValuesRequest,
  SetupObjectParam,
  UpdateFieldRequest,
} from '@sm/contracts';
import { withTenant, type CellPrisma, type TenantContext } from '@sm/db';
import { ZodPipe } from '@sm/server-kit';
import type { z } from 'zod';

import {
  RequireSystemPermission,
  SystemPermissionGuard,
} from '../access/system-permission.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentTenant, TenantContextGuard } from '../tenancy/tenant-context.guard.js';
import { PRISMA } from '../tokens.js';
import { FieldSetupService } from './field-setup.service.js';

type Obj = z.infer<typeof SetupObjectParam>;
type Fld = z.infer<typeof FieldParam>;

/** Setup → Object manager. Reading needs view_setup; changes need customize_application. */
@Controller('v1/setup/objects/:object')
@UseGuards(AuthGuard, TenantContextGuard, SystemPermissionGuard)
@RequireSystemPermission('view_setup')
export class MetadataSetupController {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly fields: FieldSetupService,
  ) {}

  @Get('fields')
  listFieldSettings(
    @CurrentTenant() t: TenantContext,
    @Param(new ZodPipe(SetupObjectParam)) p: Obj,
  ) {
    return withTenant(this.prisma, t, (tx) => this.fields.list(tx, p.object));
  }

  @Post('fields')
  @RequireSystemPermission('customize_application')
  createCustomField(
    @CurrentTenant() t: TenantContext,
    @Param(new ZodPipe(SetupObjectParam)) p: Obj,
    @Body(new ZodPipe(CreateFieldRequest)) body: z.infer<typeof CreateFieldRequest>,
  ) {
    return withTenant(this.prisma, t, (tx) => this.fields.create(tx, p.object, body));
  }

  @Patch('fields/:field')
  @RequireSystemPermission('customize_application')
  updateFieldSettings(
    @CurrentTenant() t: TenantContext,
    @Param(new ZodPipe(FieldParam)) p: Fld,
    @Body(new ZodPipe(UpdateFieldRequest)) body: z.infer<typeof UpdateFieldRequest>,
  ) {
    return withTenant(this.prisma, t, (tx) => this.fields.update(tx, p.object, p.field, body));
  }

  @Delete('fields/:field')
  @HttpCode(204)
  @RequireSystemPermission('customize_application')
  async deleteCustomField(
    @CurrentTenant() t: TenantContext,
    @Param(new ZodPipe(FieldParam)) p: Fld,
  ) {
    await withTenant(this.prisma, t, (tx) => this.fields.remove(tx, p.object, p.field));
  }

  @Put('fields/:field/picklist-values')
  @RequireSystemPermission('customize_application')
  putPicklistValues(
    @CurrentTenant() t: TenantContext,
    @Param(new ZodPipe(FieldParam)) p: Fld,
    @Body(new ZodPipe(PutPicklistValuesRequest)) body: z.infer<typeof PutPicklistValuesRequest>,
  ) {
    return withTenant(this.prisma, t, (tx) => this.fields.putValues(tx, p.object, p.field, body));
  }
}
