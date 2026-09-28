import { Injectable } from '@nestjs/common';
import type {
  AddCurrencyRequest,
  CurrencyRateDto,
  PutRateRequest,
  RateChangeDto,
  TenantCurrencyDto,
  UpdateCurrencyRequest,
} from '@sm/contracts';
import { audit, outbox, type TenantTransaction } from '@sm/db';
import { dateIn } from '@sm/formula';
import { CURRENCY_RECALC_TOPIC } from '@sm/records';
import { errors } from '@sm/server-kit';
import type { z } from 'zod';

import { invalid, staleVersion } from '../setup/common.js';

type Rate = z.infer<typeof CurrencyRateDto>;
type TenantCurrency = z.infer<typeof TenantCurrencyDto>;

const day = (d: Date) => d.toISOString().slice(0, 10);
const rateDto = (r: {
  id: string;
  code: string;
  effectiveDate: Date;
  rate: { toString(): string };
  version: number;
}): Rate => ({
  id: r.id,
  code: r.code,
  effectiveDate: day(r.effectiveDate),
  rate: r.rate.toString(),
  version: r.version,
});

/**
 * Setup → Currencies & rates (Q13, ADR-0031). The corporate currency is fixed at signup and has
 * no rates; other currencies are added, deactivated (records keep them) and given dated rates,
 * in units per one unit of the corporate currency. Changing or removing a rate queues a
 * recalculation of the corporate amounts it governs.
 */
@Injectable()
export class CurrencyService {
  private async settings(tx: TenantTransaction) {
    return tx.prisma.tenantSettings.findUniqueOrThrow({
      where: { tenantId: tx.context.tenantId },
      select: { corporateCurrency: true, defaultTimezone: true },
    });
  }

  /** A non-corporate currency of the organisation, or 404 / 409. */
  private async usedCurrency(
    tx: TenantTransaction,
    code: string,
    corporateIs: 'conflict' | 'missing',
  ) {
    const { corporateCurrency } = await this.settings(tx);
    if (code === corporateCurrency) {
      if (corporateIs === 'missing') throw errors.notFound('Currency');
      throw errors.conflict('The corporate currency has no exchange rates');
    }
    const row = await tx.prisma.tenantCurrency.findUnique({
      where: { tenantId_code: { tenantId: tx.context.tenantId, code } },
    });
    if (!row) throw errors.notFound('Currency');
    return row;
  }

  async list(tx: TenantTransaction): Promise<{ items: TenantCurrency[] }> {
    const settings = await this.settings(tx);
    const today = dateIn(new Date(), settings.defaultTimezone);
    const used = await tx.prisma.tenantCurrency.findMany({ orderBy: { code: 'asc' } });
    const codes = [settings.corporateCurrency, ...used.map((c) => c.code)];
    const names = new Map(
      (await tx.prisma.currency.findMany({ where: { code: { in: codes } } })).map((c) => [
        c.code,
        c,
      ]),
    );
    const items: TenantCurrency[] = [];
    for (const code of codes) {
      const corporate = code === settings.corporateCurrency;
      const current = corporate
        ? null
        : await tx.prisma.currencyRate.findFirst({
            where: { code, effectiveDate: { lte: new Date(today) } },
            orderBy: { effectiveDate: 'desc' },
          });
      items.push({
        code,
        name: names.get(code)?.name ?? code,
        minorUnits: names.get(code)?.minorUnits ?? 2,
        corporate,
        active: corporate || (used.find((c) => c.code === code)?.active ?? false),
        currentRate: current ? rateDto(current) : null,
      });
    }
    return { items };
  }

  private async one(tx: TenantTransaction, code: string): Promise<TenantCurrency> {
    const found = (await this.list(tx)).items.find((c) => c.code === code);
    if (!found) throw errors.notFound('Currency');
    return found;
  }

  async add(
    tx: TenantTransaction,
    body: z.infer<typeof AddCurrencyRequest>,
  ): Promise<TenantCurrency> {
    const { corporateCurrency } = await this.settings(tx);
    if (body.code === corporateCurrency)
      throw errors.conflict('That is the corporate currency; it is always in use');
    if (!(await tx.prisma.currency.findUnique({ where: { code: body.code } })))
      throw invalid('code', 'Not an ISO-4217 currency', 'unknown_currency');
    const existing = await tx.prisma.tenantCurrency.findUnique({
      where: { tenantId_code: { tenantId: tx.context.tenantId, code: body.code } },
    });
    if (existing) throw errors.conflict('The organisation already uses that currency');
    await tx.prisma.tenantCurrency.create({
      data: {
        tenantId: tx.context.tenantId,
        code: body.code,
        createdBy: tx.context.userId ?? null,
      },
    });
    await audit.setup(tx, {
      action: 'currency.added',
      entityType: 'currency',
      entityName: body.code,
      after: { code: body.code, active: true },
    });
    return this.one(tx, body.code);
  }

  async update(
    tx: TenantTransaction,
    code: string,
    body: z.infer<typeof UpdateCurrencyRequest>,
  ): Promise<TenantCurrency> {
    const { corporateCurrency } = await this.settings(tx);
    if (code === corporateCurrency) {
      if (!body.active) throw errors.conflict('The corporate currency cannot be deactivated');
      return this.one(tx, code);
    }
    const row = await this.usedCurrency(tx, code, 'missing');
    if (row.active !== body.active) {
      await tx.prisma.tenantCurrency.update({
        where: { tenantId_code: { tenantId: tx.context.tenantId, code } },
        data: { active: body.active },
      });
      await audit.setup(tx, {
        action: body.active ? 'currency.activated' : 'currency.deactivated',
        entityType: 'currency',
        entityName: code,
        before: { active: row.active },
        after: { active: body.active },
      });
    }
    return this.one(tx, code);
  }

  async listRates(tx: TenantTransaction, code: string): Promise<{ items: Rate[] }> {
    await this.usedCurrency(tx, code, 'missing');
    const rows = await tx.prisma.currencyRate.findMany({
      where: { code },
      orderBy: { effectiveDate: 'desc' },
    });
    return { items: rows.map(rateDto) };
  }

  /** Queue the recalculation of the corporate amounts a rate on `date` governs. */
  private async recalculate(tx: TenantTransaction, code: string, date: string, subjectId: string) {
    const run = await tx.prisma.jobRun.create({
      data: {
        tenantId: tx.context.tenantId,
        kind: 'currency_recalc',
        subjectId,
        createdBy: tx.context.userId ?? null,
      },
    });
    await outbox.emit(tx, {
      topic: CURRENCY_RECALC_TOPIC,
      aggregateType: 'currency_rate',
      aggregateId: subjectId,
      payload: { jobRunId: run.id, code, date },
    });
    return run.id;
  }

  async putRate(
    tx: TenantTransaction,
    code: string,
    date: string,
    body: z.infer<typeof PutRateRequest>,
  ): Promise<z.infer<typeof RateChangeDto>> {
    await this.usedCurrency(tx, code, 'conflict');
    const tenantId = tx.context.tenantId;
    const userId = tx.context.userId ?? null;
    const existing = await tx.prisma.currencyRate.findUnique({
      where: { tenantId_code_effectiveDate: { tenantId, code, effectiveDate: new Date(date) } },
    });
    if (existing && body.version !== undefined && existing.version !== body.version)
      throw staleVersion('rate');
    const saved = existing
      ? await tx.prisma.currencyRate.update({
          where: { tenantId_id: { tenantId, id: existing.id } },
          data: { rate: body.rate, version: { increment: 1 }, updatedBy: userId },
        })
      : await tx.prisma.currencyRate.create({
          data: {
            tenantId,
            code,
            effectiveDate: new Date(date),
            rate: body.rate,
            createdBy: userId,
            updatedBy: userId,
          },
        });
    await audit.setup(tx, {
      action: existing ? 'currency_rate.updated' : 'currency_rate.created',
      entityType: 'currency_rate',
      entityId: saved.id,
      entityName: `${code} ${date}`,
      ...(existing ? { before: { rate: existing.rate.toString() } } : {}),
      after: { rate: saved.rate.toString() },
    });
    const jobId = await this.recalculate(tx, code, date, saved.id);
    return { rate: rateDto(saved), recalculationJobId: jobId };
  }

  async deleteRate(
    tx: TenantTransaction,
    code: string,
    date: string,
  ): Promise<z.infer<typeof RateChangeDto>> {
    await this.usedCurrency(tx, code, 'missing');
    const tenantId = tx.context.tenantId;
    const existing = await tx.prisma.currencyRate.findUnique({
      where: { tenantId_code_effectiveDate: { tenantId, code, effectiveDate: new Date(date) } },
    });
    if (!existing) throw errors.notFound('Rate');
    await tx.prisma.currencyRate.delete({ where: { tenantId_id: { tenantId, id: existing.id } } });
    await audit.setup(tx, {
      action: 'currency_rate.deleted',
      entityType: 'currency_rate',
      entityId: existing.id,
      entityName: `${code} ${date}`,
      before: { rate: existing.rate.toString() },
    });
    const jobId = await this.recalculate(tx, code, date, existing.id);
    return { rate: null, recalculationJobId: jobId };
  }
}
