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
  CreateCompactLayoutRequest,
  CreateFieldRequest,
  CreateLayoutRequest,
  CreateRecordTypeRequest,
  CreateValidationRuleRequest,
  FieldParam,
  PathParam,
  PutLayoutAssignmentsRequest,
  PutPathRequest,
  PutPicklistValuesRequest,
  SetupItemParam,
  SetupObjectParam,
  UpdateCompactLayoutRequest,
  UpdateFieldRequest,
  UpdateLayoutRequest,
  UpdateRecordTypeRequest,
  UpdateValidationRuleRequest,
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
import { LayoutSetupService } from './layout-setup.service.js';

type Obj = z.infer<typeof SetupObjectParam>;
type Fld = z.infer<typeof FieldParam>;
type Item = z.infer<typeof SetupItemParam>;
type Path = z.infer<typeof PathParam>;
const change = () => RequireSystemPermission('customize_application');

/** Setup → Object manager. Reading needs view_setup; changes need customize_application. */
@Controller('v1/setup/objects/:object')
@UseGuards(AuthGuard, TenantContextGuard, SystemPermissionGuard)
@RequireSystemPermission('view_setup')
export class MetadataSetupController {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly fields: FieldSetupService,
    private readonly layouts: LayoutSetupService,
  ) {}

  private run<T>(
    t: TenantContext,
    fn: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>,
  ) {
    return withTenant(this.prisma, t, fn);
  }

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

  // ── Record types ──
  @Get('record-types')
  listRecordTypes(@CurrentTenant() t: TenantContext, @Param(new ZodPipe(SetupObjectParam)) p: Obj) {
    return this.run(t, (tx) => this.layouts.listRecordTypes(tx, p.object));
  }
  @Post('record-types')
  @change()
  createRecordType(
    @CurrentTenant() t: TenantContext,
    @Param(new ZodPipe(SetupObjectParam)) p: Obj,
    @Body(new ZodPipe(CreateRecordTypeRequest)) body: z.infer<typeof CreateRecordTypeRequest>,
  ) {
    return this.run(t, (tx) => this.layouts.createRecordType(tx, p.object, body));
  }
  @Patch('record-types/:id')
  @change()
  updateRecordType(
    @CurrentTenant() t: TenantContext,
    @Param(new ZodPipe(SetupItemParam)) p: Item,
    @Body(new ZodPipe(UpdateRecordTypeRequest)) body: z.infer<typeof UpdateRecordTypeRequest>,
  ) {
    return this.run(t, (tx) => this.layouts.updateRecordType(tx, p.object, p.id, body));
  }

  // ── Page layouts and assignments ──
  @Get('layouts')
  listPageLayouts(@CurrentTenant() t: TenantContext, @Param(new ZodPipe(SetupObjectParam)) p: Obj) {
    return this.run(t, (tx) => this.layouts.listLayouts(tx, p.object));
  }
  @Post('layouts')
  @change()
  createPageLayout(
    @CurrentTenant() t: TenantContext,
    @Param(new ZodPipe(SetupObjectParam)) p: Obj,
    @Body(new ZodPipe(CreateLayoutRequest)) body: z.infer<typeof CreateLayoutRequest>,
  ) {
    return this.run(t, (tx) => this.layouts.createLayout(tx, p.object, body));
  }
  @Patch('layouts/:id')
  @change()
  updatePageLayout(
    @CurrentTenant() t: TenantContext,
    @Param(new ZodPipe(SetupItemParam)) p: Item,
    @Body(new ZodPipe(UpdateLayoutRequest)) body: z.infer<typeof UpdateLayoutRequest>,
  ) {
    return this.run(t, (tx) => this.layouts.updateLayout(tx, p.object, p.id, body));
  }
  @Delete('layouts/:id')
  @HttpCode(204)
  @change()
  async deletePageLayout(
    @CurrentTenant() t: TenantContext,
    @Param(new ZodPipe(SetupItemParam)) p: Item,
  ) {
    await this.run(t, (tx) => this.layouts.deleteLayout(tx, p.object, p.id));
  }
  @Get('layout-assignments')
  getLayoutAssignments(
    @CurrentTenant() t: TenantContext,
    @Param(new ZodPipe(SetupObjectParam)) p: Obj,
  ) {
    return this.run(t, (tx) => this.layouts.getAssignments(tx, p.object));
  }
  @Put('layout-assignments')
  @change()
  putLayoutAssignments(
    @CurrentTenant() t: TenantContext,
    @Param(new ZodPipe(SetupObjectParam)) p: Obj,
    @Body(new ZodPipe(PutLayoutAssignmentsRequest))
    body: z.infer<typeof PutLayoutAssignmentsRequest>,
  ) {
    return this.run(t, (tx) => this.layouts.putAssignments(tx, p.object, body));
  }

  // ── Compact layouts ──
  @Get('compact-layouts')
  listCompactLayouts(
    @CurrentTenant() t: TenantContext,
    @Param(new ZodPipe(SetupObjectParam)) p: Obj,
  ) {
    return this.run(t, (tx) => this.layouts.listCompact(tx, p.object));
  }
  @Post('compact-layouts')
  @change()
  createCompactLayout(
    @CurrentTenant() t: TenantContext,
    @Param(new ZodPipe(SetupObjectParam)) p: Obj,
    @Body(new ZodPipe(CreateCompactLayoutRequest)) body: z.infer<typeof CreateCompactLayoutRequest>,
  ) {
    return this.run(t, (tx) => this.layouts.createCompact(tx, p.object, body));
  }
  @Patch('compact-layouts/:id')
  @change()
  updateCompactLayout(
    @CurrentTenant() t: TenantContext,
    @Param(new ZodPipe(SetupItemParam)) p: Item,
    @Body(new ZodPipe(UpdateCompactLayoutRequest)) body: z.infer<typeof UpdateCompactLayoutRequest>,
  ) {
    return this.run(t, (tx) => this.layouts.updateCompact(tx, p.object, p.id, body));
  }
  @Delete('compact-layouts/:id')
  @HttpCode(204)
  @change()
  async deleteCompactLayout(
    @CurrentTenant() t: TenantContext,
    @Param(new ZodPipe(SetupItemParam)) p: Item,
  ) {
    await this.run(t, (tx) => this.layouts.deleteCompact(tx, p.object, p.id));
  }

  // ── Paths ──
  @Get('paths')
  listPaths(@CurrentTenant() t: TenantContext, @Param(new ZodPipe(SetupObjectParam)) p: Obj) {
    return this.run(t, (tx) => this.layouts.listPaths(tx, p.object));
  }
  @Put('paths/:recordTypeId/:field')
  @change()
  putPath(
    @CurrentTenant() t: TenantContext,
    @Param(new ZodPipe(PathParam)) p: Path,
    @Body(new ZodPipe(PutPathRequest)) body: z.infer<typeof PutPathRequest>,
  ) {
    return this.run(t, (tx) => this.layouts.putPath(tx, p.object, p.recordTypeId, p.field, body));
  }
  @Delete('paths/:recordTypeId/:field')
  @HttpCode(204)
  @change()
  async deletePath(@CurrentTenant() t: TenantContext, @Param(new ZodPipe(PathParam)) p: Path) {
    await this.run(t, (tx) => this.layouts.deletePath(tx, p.object, p.recordTypeId, p.field));
  }

  // ── Validation rules ──
  @Get('validation-rules')
  listValidationRules(
    @CurrentTenant() t: TenantContext,
    @Param(new ZodPipe(SetupObjectParam)) p: Obj,
  ) {
    return this.run(t, (tx) => this.layouts.listRules(tx, p.object));
  }
  @Post('validation-rules')
  @change()
  createValidationRule(
    @CurrentTenant() t: TenantContext,
    @Param(new ZodPipe(SetupObjectParam)) p: Obj,
    @Body(new ZodPipe(CreateValidationRuleRequest))
    body: z.infer<typeof CreateValidationRuleRequest>,
  ) {
    return this.run(t, (tx) => this.layouts.createRule(tx, p.object, body));
  }
  @Patch('validation-rules/:id')
  @change()
  updateValidationRule(
    @CurrentTenant() t: TenantContext,
    @Param(new ZodPipe(SetupItemParam)) p: Item,
    @Body(new ZodPipe(UpdateValidationRuleRequest))
    body: z.infer<typeof UpdateValidationRuleRequest>,
  ) {
    return this.run(t, (tx) => this.layouts.updateRule(tx, p.object, p.id, body));
  }
  @Delete('validation-rules/:id')
  @HttpCode(204)
  @change()
  async deleteValidationRule(
    @CurrentTenant() t: TenantContext,
    @Param(new ZodPipe(SetupItemParam)) p: Item,
  ) {
    await this.run(t, (tx) => this.layouts.deleteRule(tx, p.object, p.id));
  }
}
