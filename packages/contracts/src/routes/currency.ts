import { z } from 'zod';

import { defineRoute } from '../openapi.js';
import { CurrencyCode, Uuid } from '../primitives.js';
/** `YYYY-MM-DD`. */
const IsoDate = z.iso.date();
/**
 * Units of the currency per one unit of the corporate currency, as a decimal string (money is
 * never a float, golden rule 8): positive, up to 10 integer and 8 fractional digits.
 */
export const RateValue = z
  .string()
  .regex(/^\d{1,10}(\.\d{1,8})?$/, 'Must be a decimal with up to 8 decimal places')
  .refine((v) => /[1-9]/.test(v), 'Must be greater than zero');

export const CurrencyRateDto = z
  .object({
    id: Uuid,
    code: CurrencyCode,
    effectiveDate: IsoDate,
    rate: z.string(),
    version: z.number().int(),
  })
  .meta({ id: 'CurrencyRate' });

export const TenantCurrencyDto = z
  .object({
    code: CurrencyCode,
    name: z.string(),
    minorUnits: z.number().int(),
    /** The organisation's corporate currency: always active, never has rates. */
    corporate: z.boolean(),
    active: z.boolean(),
    /** The rate in force today, if any. */
    currentRate: CurrencyRateDto.nullable(),
  })
  .meta({ id: 'TenantCurrency' });

export const AddCurrencyRequest = z.object({ code: CurrencyCode }).strict();
export const UpdateCurrencyRequest = z.object({ active: z.boolean() }).strict();
export const PutRateRequest = z
  .object({
    rate: RateValue,
    /** Optimistic lock when changing an existing rate. */
    version: z.number().int().positive().optional(),
  })
  .strict();

export const CurrencyParam = z.object({ code: CurrencyCode });
export const RateParam = z.object({ code: CurrencyCode, date: IsoDate });

/** A rate change starts a recalculation of the corporate amounts it affects. */
export const RateChangeDto = z
  .object({ rate: CurrencyRateDto.nullable(), recalculationJobId: Uuid })
  .meta({ id: 'RateChange' });

const forbidden = { 403: { description: 'The caller lacks the required system permission' } };
const route = (spec: Omit<Parameters<typeof defineRoute>[0], 'tags' | 'auth' | 'visibility'>) =>
  defineRoute({ ...spec, tags: ['setup'], auth: 'session', visibility: 'internal' });

/** Setup → Currencies & rates (Q13, ADR-0031). Reading needs view_setup, changes customize_application. */
export const currencyRoutes = {
  listCurrencies: route({
    method: 'get',
    path: '/v1/currencies',
    operationId: 'listCurrencies',
    summary: 'The corporate currency and the currencies the organisation uses',
    responses: {
      200: { description: 'Currencies', body: z.object({ items: z.array(TenantCurrencyDto) }) },
      ...forbidden,
    },
  }),
  addCurrency: route({
    method: 'post',
    path: '/v1/currencies',
    operationId: 'addCurrency',
    summary: 'Start using a currency',
    request: { body: AddCurrencyRequest },
    responses: {
      201: { description: 'The currency', body: TenantCurrencyDto },
      400: { description: 'Not an ISO-4217 currency' },
      409: { description: 'Already in use, or the corporate currency' },
      ...forbidden,
    },
  }),
  updateCurrency: route({
    method: 'patch',
    path: '/v1/currencies/{code}',
    operationId: 'updateCurrency',
    summary: 'Activate or deactivate a currency (existing records keep it)',
    request: { params: CurrencyParam, body: UpdateCurrencyRequest },
    responses: {
      200: { description: 'The currency', body: TenantCurrencyDto },
      404: { description: 'Not a currency of the organisation' },
      409: { description: 'The corporate currency cannot be deactivated' },
      ...forbidden,
    },
  }),
  listRates: route({
    method: 'get',
    path: '/v1/currencies/{code}/rates',
    operationId: 'listCurrencyRates',
    summary: 'Dated rates of a currency, newest first',
    request: { params: CurrencyParam },
    responses: {
      200: { description: 'Rates', body: z.object({ items: z.array(CurrencyRateDto) }) },
      404: { description: 'Not a currency of the organisation' },
      ...forbidden,
    },
  }),
  putRate: route({
    method: 'put',
    path: '/v1/currencies/{code}/rates/{date}',
    operationId: 'putCurrencyRate',
    summary: 'Set the rate in force from a date; affected corporate amounts are recalculated',
    request: { params: RateParam, body: PutRateRequest },
    responses: {
      200: { description: 'The rate and its recalculation job', body: RateChangeDto },
      404: { description: 'Not a currency of the organisation' },
      409: { description: 'Stale version, or the corporate currency' },
      ...forbidden,
    },
  }),
  deleteRate: route({
    method: 'delete',
    path: '/v1/currencies/{code}/rates/{date}',
    operationId: 'deleteCurrencyRate',
    summary: 'Remove a dated rate; the previous rate applies from that date',
    request: { params: RateParam },
    responses: {
      200: { description: 'The recalculation job', body: RateChangeDto },
      404: { description: 'No rate on that date' },
      ...forbidden,
    },
  }),
};
