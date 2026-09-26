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
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CreateGroupRequest,
  CreateOrgUnitRequest,
  CreatePermissionSetGroupRequest,
  CreatePermissionSetRequest,
  CreateProfileRequest,
  CreateQueueRequest,
  CreateSharingRuleRequest,
  ManualShareRequest,
  PutGrantsRequest,
  RevokeShareQuery,
  setupRoutes,
  SetupIdParam,
  UpdateGroupRequest,
  UpdateNamedRequest,
  UpdateOrgUnitRequest,
  UpdateOrgWideDefaultRequest,
  UpdatePermissionSetGroupRequest,
  UpdateQueueRequest,
  UpdateSharingRuleRequest,
} from '@sm/contracts';
import { withTenant, type CellPrisma, type TenantContext, type TenantTransaction } from '@sm/db';
import { ZodPipe } from '@sm/server-kit';
import type { z } from 'zod';

import {
  RequireSystemPermission,
  SystemPermissionGuard,
} from '../access/system-permission.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentTenant, TenantContextGuard } from '../tenancy/tenant-context.guard.js';
import { PRISMA } from '../tokens.js';
import { GroupsService } from './groups.service.js';
import { OrgUnitsService } from './org-units.service.js';
import { PermissionSetupService } from './permission-setup.service.js';
import { SharingSetupService } from './sharing-setup.service.js';

const IdParam = SetupIdParam;
type Id = z.infer<typeof IdParam>;
const ObjectParam = setupRoutes.updateOrgWideDefault.request.params;
const RecordParam = setupRoutes.listRecordShares.request.params;
type Body<T extends z.ZodType> = z.infer<T>;

abstract class TenantController {
  constructor(protected readonly prisma: CellPrisma) {}
  protected run<T>(ctx: TenantContext, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
    return withTenant(this.prisma, ctx, fn);
  }
}

/**
 * Setup → hierarchy, users' permissions, groups and queues (§6.2, §6.3). Reading needs
 * view_setup; every change needs manage_users.
 */
@Controller('v1')
@UseGuards(AuthGuard, TenantContextGuard, SystemPermissionGuard)
@RequireSystemPermission('view_setup')
export class PeopleSetupController extends TenantController {
  constructor(
    @Inject(PRISMA) prisma: CellPrisma,
    private readonly units: OrgUnitsService,
    private readonly groups: GroupsService,
    private readonly perms: PermissionSetupService,
  ) {
    super(prisma);
  }

  // Org units
  @Get('org-units')
  listOrgUnits(@CurrentTenant() ctx: TenantContext) {
    return this.run(ctx, (tx) => this.units.list(tx));
  }
  @Get('org-units/:id')
  getOrgUnit(@CurrentTenant() ctx: TenantContext, @Param(new ZodPipe(IdParam)) p: Id) {
    return this.run(ctx, (tx) => this.units.get(tx, p.id));
  }
  @Post('org-units')
  @RequireSystemPermission('manage_users')
  createOrgUnit(
    @CurrentTenant() ctx: TenantContext,
    @Body(new ZodPipe(CreateOrgUnitRequest)) body: Body<typeof CreateOrgUnitRequest>,
  ) {
    return this.run(ctx, (tx) => this.units.create(tx, body));
  }
  @Patch('org-units/:id')
  @RequireSystemPermission('manage_users')
  updateOrgUnit(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(IdParam)) p: Id,
    @Body(new ZodPipe(UpdateOrgUnitRequest)) body: Body<typeof UpdateOrgUnitRequest>,
  ) {
    return this.run(ctx, (tx) => this.units.update(tx, p.id, body));
  }
  @Delete('org-units/:id')
  @HttpCode(204)
  @RequireSystemPermission('manage_users')
  async deleteOrgUnit(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(IdParam)) p: Id,
  ): Promise<void> {
    await this.run(ctx, (tx) => this.units.remove(tx, p.id));
  }

  // Public groups
  @Get('groups')
  listGroups(@CurrentTenant() ctx: TenantContext) {
    return this.run(ctx, (tx) => this.groups.listGroups(tx));
  }
  @Get('groups/:id')
  getGroup(@CurrentTenant() ctx: TenantContext, @Param(new ZodPipe(IdParam)) p: Id) {
    return this.run(ctx, (tx) => this.groups.getGroup(tx, p.id));
  }
  @Post('groups')
  @RequireSystemPermission('manage_users')
  createGroup(
    @CurrentTenant() ctx: TenantContext,
    @Body(new ZodPipe(CreateGroupRequest)) body: Body<typeof CreateGroupRequest>,
  ) {
    return this.run(ctx, (tx) => this.groups.createGroup(tx, body));
  }
  @Patch('groups/:id')
  @RequireSystemPermission('manage_users')
  updateGroup(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(IdParam)) p: Id,
    @Body(new ZodPipe(UpdateGroupRequest)) body: Body<typeof UpdateGroupRequest>,
  ) {
    return this.run(ctx, (tx) => this.groups.updateGroup(tx, p.id, body));
  }
  @Delete('groups/:id')
  @HttpCode(204)
  @RequireSystemPermission('manage_users')
  async deleteGroup(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(IdParam)) p: Id,
  ): Promise<void> {
    await this.run(ctx, (tx) => this.groups.removeGroup(tx, p.id));
  }

  // Queues
  @Get('queues')
  listQueues(@CurrentTenant() ctx: TenantContext) {
    return this.run(ctx, (tx) => this.groups.listQueues(tx));
  }
  @Get('queues/:id')
  getQueue(@CurrentTenant() ctx: TenantContext, @Param(new ZodPipe(IdParam)) p: Id) {
    return this.run(ctx, (tx) => this.groups.getQueue(tx, p.id));
  }
  @Post('queues')
  @RequireSystemPermission('manage_users')
  createQueue(
    @CurrentTenant() ctx: TenantContext,
    @Body(new ZodPipe(CreateQueueRequest)) body: Body<typeof CreateQueueRequest>,
  ) {
    return this.run(ctx, (tx) => this.groups.createQueue(tx, body));
  }
  @Patch('queues/:id')
  @RequireSystemPermission('manage_users')
  updateQueue(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(IdParam)) p: Id,
    @Body(new ZodPipe(UpdateQueueRequest)) body: Body<typeof UpdateQueueRequest>,
  ) {
    return this.run(ctx, (tx) => this.groups.updateQueue(tx, p.id, body));
  }
  @Delete('queues/:id')
  @HttpCode(204)
  @RequireSystemPermission('manage_users')
  async deleteQueue(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(IdParam)) p: Id,
  ): Promise<void> {
    await this.run(ctx, (tx) => this.groups.removeQueue(tx, p.id));
  }

  // Profiles
  @Get('profiles')
  listProfiles(@CurrentTenant() ctx: TenantContext) {
    return this.run(ctx, (tx) => this.perms.listProfiles(tx));
  }
  @Get('profiles/:id')
  getProfile(@CurrentTenant() ctx: TenantContext, @Param(new ZodPipe(IdParam)) p: Id) {
    return this.run(ctx, (tx) => this.perms.getProfile(tx, p.id));
  }
  @Post('profiles')
  @RequireSystemPermission('manage_users')
  createProfile(
    @CurrentTenant() ctx: TenantContext,
    @Body(new ZodPipe(CreateProfileRequest)) body: Body<typeof CreateProfileRequest>,
  ) {
    return this.run(ctx, (tx) => this.perms.createProfile(tx, body));
  }
  @Patch('profiles/:id')
  @RequireSystemPermission('manage_users')
  updateProfile(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(IdParam)) p: Id,
    @Body(new ZodPipe(UpdateNamedRequest)) body: Body<typeof UpdateNamedRequest>,
  ) {
    return this.run(ctx, (tx) => this.perms.updateProfile(tx, p.id, body));
  }
  @Put('profiles/:id/grants')
  @RequireSystemPermission('manage_users')
  putProfileGrants(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(IdParam)) p: Id,
    @Body(new ZodPipe(PutGrantsRequest)) body: Body<typeof PutGrantsRequest>,
  ) {
    return this.run(ctx, (tx) => this.perms.putProfileGrants(tx, p.id, body));
  }
  @Delete('profiles/:id')
  @HttpCode(204)
  @RequireSystemPermission('manage_users')
  async deleteProfile(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(IdParam)) p: Id,
  ): Promise<void> {
    await this.run(ctx, (tx) => this.perms.removeProfile(tx, p.id));
  }

  // Permission sets
  @Get('permission-sets')
  listPermissionSets(@CurrentTenant() ctx: TenantContext) {
    return this.run(ctx, (tx) => this.perms.listSets(tx));
  }
  @Get('permission-sets/:id')
  getPermissionSet(@CurrentTenant() ctx: TenantContext, @Param(new ZodPipe(IdParam)) p: Id) {
    return this.run(ctx, (tx) => this.perms.getSet(tx, p.id));
  }
  @Post('permission-sets')
  @RequireSystemPermission('manage_users')
  createPermissionSet(
    @CurrentTenant() ctx: TenantContext,
    @Body(new ZodPipe(CreatePermissionSetRequest)) body: Body<typeof CreatePermissionSetRequest>,
  ) {
    return this.run(ctx, (tx) => this.perms.createSet(tx, body));
  }
  @Patch('permission-sets/:id')
  @RequireSystemPermission('manage_users')
  updatePermissionSet(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(IdParam)) p: Id,
    @Body(new ZodPipe(UpdateNamedRequest)) body: Body<typeof UpdateNamedRequest>,
  ) {
    return this.run(ctx, (tx) => this.perms.updateSet(tx, p.id, body));
  }
  @Put('permission-sets/:id/grants')
  @RequireSystemPermission('manage_users')
  putPermissionSetGrants(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(IdParam)) p: Id,
    @Body(new ZodPipe(PutGrantsRequest)) body: Body<typeof PutGrantsRequest>,
  ) {
    return this.run(ctx, (tx) => this.perms.putSetGrants(tx, p.id, body));
  }
  @Delete('permission-sets/:id')
  @HttpCode(204)
  @RequireSystemPermission('manage_users')
  async deletePermissionSet(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(IdParam)) p: Id,
  ): Promise<void> {
    await this.run(ctx, (tx) => this.perms.removeSet(tx, p.id));
  }

  // Permission set groups
  @Get('permission-set-groups')
  listPermissionSetGroups(@CurrentTenant() ctx: TenantContext) {
    return this.run(ctx, (tx) => this.perms.listGroups(tx));
  }
  @Get('permission-set-groups/:id')
  getPermissionSetGroup(@CurrentTenant() ctx: TenantContext, @Param(new ZodPipe(IdParam)) p: Id) {
    return this.run(ctx, (tx) => this.perms.getGroup(tx, p.id));
  }
  @Post('permission-set-groups')
  @RequireSystemPermission('manage_users')
  createPermissionSetGroup(
    @CurrentTenant() ctx: TenantContext,
    @Body(new ZodPipe(CreatePermissionSetGroupRequest))
    body: Body<typeof CreatePermissionSetGroupRequest>,
  ) {
    return this.run(ctx, (tx) => this.perms.createGroup(tx, body));
  }
  @Patch('permission-set-groups/:id')
  @RequireSystemPermission('manage_users')
  updatePermissionSetGroup(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(IdParam)) p: Id,
    @Body(new ZodPipe(UpdatePermissionSetGroupRequest))
    body: Body<typeof UpdatePermissionSetGroupRequest>,
  ) {
    return this.run(ctx, (tx) => this.perms.updateGroup(tx, p.id, body));
  }
  @Delete('permission-set-groups/:id')
  @HttpCode(204)
  @RequireSystemPermission('manage_users')
  async deletePermissionSetGroup(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(IdParam)) p: Id,
  ): Promise<void> {
    await this.run(ctx, (tx) => this.perms.removeGroup(tx, p.id));
  }
}

/** Setup → Sharing settings (§6.3): reading needs view_setup, changes customize_application. */
@Controller('v1/sharing')
@UseGuards(AuthGuard, TenantContextGuard, SystemPermissionGuard)
@RequireSystemPermission('view_setup')
export class SharingSetupController extends TenantController {
  constructor(
    @Inject(PRISMA) prisma: CellPrisma,
    private readonly sharing: SharingSetupService,
  ) {
    super(prisma);
  }

  @Get('owd')
  listOrgWideDefaults(@CurrentTenant() ctx: TenantContext) {
    return this.run(ctx, (tx) => this.sharing.listOwd(tx));
  }
  @Put('owd/:object')
  @RequireSystemPermission('customize_application')
  updateOrgWideDefault(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(ObjectParam)) p: z.infer<typeof ObjectParam>,
    @Body(new ZodPipe(UpdateOrgWideDefaultRequest)) body: Body<typeof UpdateOrgWideDefaultRequest>,
  ) {
    return this.run(ctx, (tx) => this.sharing.updateOwd(tx, p.object, body));
  }

  @Get('rules')
  listSharingRules(@CurrentTenant() ctx: TenantContext) {
    return this.run(ctx, (tx) => this.sharing.listRules(tx));
  }
  @Get('rules/:id')
  getSharingRule(@CurrentTenant() ctx: TenantContext, @Param(new ZodPipe(IdParam)) p: Id) {
    return this.run(ctx, (tx) => this.sharing.getRule(tx, p.id));
  }
  @Post('rules')
  @RequireSystemPermission('customize_application')
  createSharingRule(
    @CurrentTenant() ctx: TenantContext,
    @Body(new ZodPipe(CreateSharingRuleRequest)) body: Body<typeof CreateSharingRuleRequest>,
  ) {
    return this.run(ctx, (tx) => this.sharing.createRule(tx, body));
  }
  @Patch('rules/:id')
  @RequireSystemPermission('customize_application')
  updateSharingRule(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(IdParam)) p: Id,
    @Body(new ZodPipe(UpdateSharingRuleRequest)) body: Body<typeof UpdateSharingRuleRequest>,
  ) {
    return this.run(ctx, (tx) => this.sharing.updateRule(tx, p.id, body));
  }
  @Delete('rules/:id')
  @HttpCode(204)
  @RequireSystemPermission('customize_application')
  async deleteSharingRule(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(IdParam)) p: Id,
  ): Promise<void> {
    await this.run(ctx, (tx) => this.sharing.removeRule(tx, p.id));
  }
}

/**
 * Manual sharing of one record (§6.3). No system permission: the record decides — the caller
 * needs Full access (owner, above the owner, or Modify All), else 403, or 404 if they cannot
 * see it at all.
 */
@Controller('v1/records/:object/:id/share')
@UseGuards(AuthGuard, TenantContextGuard)
export class RecordShareController extends TenantController {
  constructor(
    @Inject(PRISMA) prisma: CellPrisma,
    private readonly sharing: SharingSetupService,
  ) {
    super(prisma);
  }

  @Get()
  listRecordShares(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(RecordParam)) p: z.infer<typeof RecordParam>,
  ) {
    return this.run(ctx, (tx) => this.sharing.listShares(tx, p.object, p.id));
  }

  @Post()
  @HttpCode(200)
  shareRecord(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(RecordParam)) p: z.infer<typeof RecordParam>,
    @Body(new ZodPipe(ManualShareRequest)) body: Body<typeof ManualShareRequest>,
  ) {
    return this.run(ctx, (tx) => this.sharing.share(tx, p.object, p.id, body));
  }

  @Delete()
  @HttpCode(204)
  async unshareRecord(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(RecordParam)) p: z.infer<typeof RecordParam>,
    @Query(new ZodPipe(RevokeShareQuery)) q: z.infer<typeof RevokeShareQuery>,
  ): Promise<void> {
    await this.run(ctx, (tx) =>
      this.sharing.unshare(tx, p.object, p.id, { type: q.principalType, id: q.principalId }),
    );
  }
}
