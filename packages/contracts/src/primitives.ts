import { z } from 'zod';

/** UUIDv7 string (§4.1, §10.1). Accepts any RFC 4122 variant with version nibble 7. */
export const Uuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    'Must be a UUIDv7',
  )
  .meta({
    id: 'Uuid',
    description: 'UUIDv7 identifier',
    example: '01920000-0000-7000-8000-000000000001',
  });

/** ISO 4217 alphabetic currency code. */
export const CurrencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Must be an ISO 4217 code')
  .meta({ id: 'CurrencyCode', example: 'USD' });

/**
 * Money on the wire (§10.1, golden rule 8): the amount is a **string decimal** with at most two
 * fraction digits and 16 integer digits, matching numeric(18,2). Never a float.
 */
export const Money = z
  .object({
    amount: z
      .string()
      .regex(
        /^-?(0|[1-9]\d{0,15})(\.\d{1,2})?$/,
        'Must be a decimal string with at most 2 fraction digits',
      ),
    currency: CurrencyCode,
  })
  .meta({ id: 'Money', example: { amount: '1250.00', currency: 'USD' } });

/** ISO-8601 UTC timestamp. */
export const Timestamp = z.iso
  .datetime({ offset: false })
  .meta({ id: 'Timestamp', example: '2026-09-25T09:30:00Z' });

/** Business date (close date, birthday): YYYY-MM-DD, no time zone (golden rule 9). */
export const BusinessDate = z.iso.date().meta({ id: 'BusinessDate', example: '2026-10-12' });

export const Email = z.email().max(254).meta({ id: 'Email' });

/** Tenant subdomain slug: lowercase letters, digits and single hyphens, 3–40 characters. */
export const TenantSlug = z
  .string()
  .regex(/^(?=.{3,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use 3–40 lowercase letters, digits or hyphens')
  .meta({ id: 'TenantSlug', example: 'pixelcraft' });
