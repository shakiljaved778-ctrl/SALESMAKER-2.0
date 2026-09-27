import type { TenantTransaction } from '@sm/db';
import { Decimal } from 'decimal.js';

import type { CurrencyConverter } from './context.js';

/**
 * Conversion from the tenant's dated rates (Q13, ADR-0031): `rate` units of a currency per one
 * unit of the corporate currency, from its effective date until the next rate. Rates and active
 * currencies are read once per transaction.
 */
export function tenantCurrencyConverter(
  tx: TenantTransaction,
  corporateCurrency: string,
): CurrencyConverter {
  const rates = new Map<string, Promise<{ date: string; rate: string }[]>>();
  let active: Promise<Set<string>> | null = null;
  const ratesOf = (code: string) => {
    let found = rates.get(code);
    if (!found) {
      found = tx.prisma.currencyRate
        .findMany({ where: { code }, orderBy: { effectiveDate: 'asc' } })
        .then((rows) =>
          rows.map((r) => ({
            date: r.effectiveDate.toISOString().slice(0, 10),
            rate: r.rate.toString(),
          })),
        );
      rates.set(code, found);
    }
    return found;
  };
  return {
    async toCorporate(amount, code, date) {
      if (code === corporateCurrency)
        return { amount: new Decimal(amount).toFixed(2), rateDate: date };
      const rate = (await ratesOf(code)).filter((r) => r.date <= date).at(-1);
      if (!rate) return null;
      return {
        amount: new Decimal(amount).div(rate.rate).toFixed(2, Decimal.ROUND_HALF_UP),
        rateDate: rate.date,
      };
    },
    async isActive(code) {
      if (code === corporateCurrency) return true;
      active ??= tx.prisma.tenantCurrency
        .findMany({ where: { active: true }, select: { code: true } })
        .then((rows) => new Set(rows.map((r) => r.code)));
      return (await active).has(code);
    },
  };
}
