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
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  CreateInboundAddressRequest,
  inboundEmailRoutes,
  SetupIdParam,
  UpdateInboundAddressRequest,
} from '@sm/contracts';
import { withTenant, type CellPrisma, type TenantContext, type TenantTransaction } from '@sm/db';
import { ZodPipe } from '@sm/server-kit';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import {
  RequireSystemPermission,
  SystemPermissionGuard,
} from '../access/system-permission.guard.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { RecordContextService } from '../records/record-context.service.js';
import { translating } from '../records/record-errors.js';
import { CurrentTenant, TenantContextGuard } from '../tenancy/tenant-context.guard.js';
import { PRISMA } from '../tokens.js';
import { InboundEmailService } from './inbound-email.service.js';

type Id = z.infer<typeof SetupIdParam>;
type Out<T extends z.ZodType> = z.output<T>;
const EmailsQuery = inboundEmailRoutes.listAddressEmails.request.query;
const RecordParams = inboundEmailRoutes.listRecordInboundEmails.request.params;
const EmailParams = inboundEmailRoutes.getRecordInboundEmail.request.params;

/** Setup → Email-to-lead (§7.1). Reading needs view_setup, changes customize_application. */
@Controller('v1/setup/inbound-addresses')
@UseGuards(AuthGuard, TenantContextGuard, SystemPermissionGuard)
@RequireSystemPermission('view_setup')
export class InboundAddressesController {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly inbound: InboundEmailService,
  ) {}

  private run<T>(ctx: TenantContext, fn: (tx: TenantTransaction) => Promise<T>) {
    return withTenant(this.prisma, ctx, fn);
  }

  @Get()
  async list(@CurrentTenant() ctx: TenantContext) {
    return { items: await this.run(ctx, (tx) => this.inbound.list(tx)) };
  }
  @Get(':id')
  get(@CurrentTenant() ctx: TenantContext, @Param(new ZodPipe(SetupIdParam)) p: Id) {
    return this.run(ctx, (tx) => this.inbound.get(tx, p.id));
  }
  @Get(':id/emails')
  emails(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(SetupIdParam)) p: Id,
    @Query(new ZodPipe(EmailsQuery)) q: Out<typeof EmailsQuery>,
  ) {
    return this.run(ctx, (tx) => this.inbound.emails(tx, p.id, q));
  }
  @Post()
  @RequireSystemPermission('customize_application')
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body(new ZodPipe(CreateInboundAddressRequest)) body: Out<typeof CreateInboundAddressRequest>,
  ) {
    return this.run(ctx, (tx) => this.inbound.create(tx, body));
  }
  @Patch(':id')
  @RequireSystemPermission('customize_application')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(SetupIdParam)) p: Id,
    @Body(new ZodPipe(UpdateInboundAddressRequest)) body: Out<typeof UpdateInboundAddressRequest>,
  ) {
    return this.run(ctx, (tx) => this.inbound.update(tx, p.id, body));
  }
  @Delete(':id')
  @HttpCode(204)
  @RequireSystemPermission('customize_application')
  async remove(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(SetupIdParam)) p: Id,
  ): Promise<void> {
    await this.run(ctx, (tx) => this.inbound.remove(tx, p.id));
  }
}

/** Delivery from the inbound adapter: no session, the adapter authenticates itself. */
@Controller('v1/inbound/email')
export class InboundDeliveryController {
  constructor(private readonly inbound: InboundEmailService) {}

  @Post()
  @HttpCode(202)
  receive(@Req() request: FastifyRequest, @Body() body: unknown) {
    const headers = Object.fromEntries(
      Object.entries(request.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
    );
    // SNS posts JSON as text/plain; parse it here.
    const parsed: unknown =
      typeof body === 'string'
        ? (() => {
            try {
              return JSON.parse(body) as unknown;
            } catch {
              return null;
            }
          })()
        : body;
    return this.inbound.receive(headers, parsed);
  }
}

/** Emails stored on a lead or contact (until P04 turns them into activities). */
@Controller('v1/records/:object/:id/inbound-emails')
@UseGuards(AuthGuard, TenantContextGuard)
export class RecordInboundEmailsController {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly contexts: RecordContextService,
    private readonly inbound: InboundEmailService,
  ) {}

  @Get()
  list(
    @CurrentTenant() t: TenantContext,
    @Req() request: FastifyRequest,
    @Param(new ZodPipe(RecordParams)) p: z.infer<typeof RecordParams>,
  ) {
    return withTenant(this.prisma, t, async (tx) =>
      translating(async () =>
        this.inbound.forRecord(tx, await this.contexts.forCaller(tx, request.id), p.object, p.id),
      ),
    );
  }

  @Get(':emailId')
  one(
    @CurrentTenant() t: TenantContext,
    @Req() request: FastifyRequest,
    @Param(new ZodPipe(EmailParams)) p: z.infer<typeof EmailParams>,
  ) {
    return withTenant(this.prisma, t, async (tx) =>
      translating(async () =>
        this.inbound.oneForRecord(
          tx,
          await this.contexts.forCaller(tx, request.id),
          p.object,
          p.id,
          p.emailId,
        ),
      ),
    );
  }
}
