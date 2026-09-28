import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  AddCurrencyRequest,
  CurrencyParam,
  PutRateRequest,
  RateParam,
  UpdateCurrencyRequest,
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
import { CurrencyService } from './currency.service.js';

type Code = z.infer<typeof CurrencyParam>;
type RateAt = z.infer<typeof RateParam>;

/** Setup → Currencies & rates. Reading needs view_setup; changes need customize_application. */
@Controller('v1/currencies')
@UseGuards(AuthGuard, TenantContextGuard, SystemPermissionGuard)
@RequireSystemPermission('view_setup')
export class CurrencyController {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly currencies: CurrencyService,
  ) {}

  @Get()
  listCurrencies(@CurrentTenant() ctx: TenantContext) {
    return withTenant(this.prisma, ctx, (tx) => this.currencies.list(tx));
  }

  @Post()
  @RequireSystemPermission('customize_application')
  addCurrency(
    @CurrentTenant() ctx: TenantContext,
    @Body(new ZodPipe(AddCurrencyRequest)) body: z.infer<typeof AddCurrencyRequest>,
  ) {
    return withTenant(this.prisma, ctx, (tx) => this.currencies.add(tx, body));
  }

  @Patch(':code')
  @RequireSystemPermission('customize_application')
  updateCurrency(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(CurrencyParam)) p: Code,
    @Body(new ZodPipe(UpdateCurrencyRequest)) body: z.infer<typeof UpdateCurrencyRequest>,
  ) {
    return withTenant(this.prisma, ctx, (tx) => this.currencies.update(tx, p.code, body));
  }

  @Get(':code/rates')
  listCurrencyRates(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(CurrencyParam)) p: Code,
  ) {
    return withTenant(this.prisma, ctx, (tx) => this.currencies.listRates(tx, p.code));
  }

  @Put(':code/rates/:date')
  @RequireSystemPermission('customize_application')
  putCurrencyRate(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(RateParam)) p: RateAt,
    @Body(new ZodPipe(PutRateRequest)) body: z.infer<typeof PutRateRequest>,
  ) {
    return withTenant(this.prisma, ctx, (tx) => this.currencies.putRate(tx, p.code, p.date, body));
  }

  @Delete(':code/rates/:date')
  @RequireSystemPermission('customize_application')
  deleteCurrencyRate(
    @CurrentTenant() ctx: TenantContext,
    @Param(new ZodPipe(RateParam)) p: RateAt,
  ) {
    return withTenant(this.prisma, ctx, (tx) => this.currencies.deleteRate(tx, p.code, p.date));
  }
}
