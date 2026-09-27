import { Decimal } from 'decimal.js';

import type { FieldMeta } from './runtime.js';
import type { FieldType } from './types.js';

/**
 * Field types (§5.3): how a value written through the API is checked and normalised before it
 * is stored. Money and numbers are never floats (§0.4 rule 8): they come back as decimal strings
 * rounded half-up to the field's scale. Dates are `YYYY-MM-DD` (business dates, rule 9),
 * date-times are ISO-8601 in UTC.
 */
export type ValueErrorCode =
  'read_only' | 'invalid_type' | 'invalid_format' | 'too_long' | 'out_of_range' | 'not_in_picklist';

export type ValueResult = { ok: true; value: unknown } | { ok: false; code: ValueErrorCode };

/** Types the platform computes; a write to them is refused. */
export const READ_ONLY_TYPES: ReadonlySet<FieldType> = new Set([
  'id',
  'auto_number',
  'formula',
  'rollup_summary',
]);

/** Default maximum lengths for text types when the field sets none. */
const MAX_LENGTH: Partial<Record<FieldType, number>> = {
  text: 255,
  email: 254,
  phone: 40,
  url: 2048,
  textarea: 4000,
  long_text: 131072,
  rich_text: 131072,
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)$/;

const ok = (value: unknown): ValueResult => ({ ok: true, value });
const fail = (code: ValueErrorCode): ValueResult => ({ ok: false, code });

function text(field: FieldMeta, raw: unknown): ValueResult {
  if (typeof raw !== 'string') return fail('invalid_type');
  const max = field.length ?? MAX_LENGTH[field.type] ?? 255;
  return raw.length > max ? fail('too_long') : ok(raw);
}

function decimal(field: FieldMeta, raw: unknown, defaultScale: number): ValueResult {
  if (typeof raw !== 'string' && typeof raw !== 'number') return fail('invalid_type');
  const s = typeof raw === 'number' ? String(raw) : raw.trim();
  if (typeof raw === 'number' && !Number.isFinite(raw)) return fail('invalid_type');
  if (!NUMERIC.test(s)) return fail('invalid_format');
  const precision = field.precision ?? 18;
  const scale = field.scale ?? defaultScale;
  const value = new Decimal(s).toDecimalPlaces(scale, Decimal.ROUND_HALF_UP);
  // At most precision − scale digits before the point.
  if (value.abs().gte(new Decimal(10).pow(precision - scale))) return fail('out_of_range');
  return ok(value.toFixed(scale));
}

function date(raw: unknown): ValueResult {
  if (typeof raw !== 'string') return fail('invalid_type');
  const m = DATE.exec(raw);
  if (!m) return fail('invalid_format');
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === raw ? ok(raw) : fail('invalid_format');
}

function datetime(raw: unknown): ValueResult {
  if (typeof raw !== 'string') return fail('invalid_type');
  // An explicit offset or Z is required: a date-time without one has no instant.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(raw))
    return fail('invalid_format');
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? fail('invalid_format') : ok(d.toISOString());
}

function url(field: FieldMeta, raw: unknown): ValueResult {
  const t = text(field, raw);
  if (!t.ok) return t;
  const s = (raw as string).trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return fail('invalid_format');
    if (!u.hostname.includes('.')) return fail('invalid_format');
    return withScheme.length > (field.length ?? 2048) ? fail('too_long') : ok(withScheme);
  } catch {
    return fail('invalid_format');
  }
}

function phone(field: FieldMeta, raw: unknown): ValueResult {
  const t = text(field, raw);
  if (!t.ok) return t;
  const s = (raw as string).trim();
  if (!/^\+?[\d\s().-]+$/.test(s)) return fail('invalid_format');
  const digits = s.replace(/\D/g, '').length;
  return digits >= 4 && digits <= 20 ? ok(s) : fail('invalid_format');
}

/**
 * Check and normalise one value for a field. `null` (and `''` for text-like types) clears the
 * field; whether that is allowed (required fields) is the caller's check, not the type's.
 * `allowedValues` restricts picklists to the record type's active values.
 */
export function normaliseValue(
  field: FieldMeta,
  raw: unknown,
  allowedValues?: readonly string[],
): ValueResult {
  if (READ_ONLY_TYPES.has(field.type) || field.system) return fail('read_only');
  if (raw === undefined || raw === null) return ok(field.type === 'checkbox' ? false : null);
  if (raw === '' && field.type !== 'checkbox') return ok(null);
  const allowed =
    allowedValues ?? field.picklistValues.filter((v) => v.active).map((v) => v.apiValue);
  switch (field.type) {
    case 'text':
    case 'textarea':
    case 'long_text':
    case 'rich_text':
      return text(field, raw);
    case 'email': {
      const t = text(field, raw);
      if (!t.ok) return t;
      const s = (raw as string).trim();
      return EMAIL.test(s) ? ok(s) : fail('invalid_format');
    }
    case 'phone':
      return phone(field, raw);
    case 'url':
      return url(field, raw);
    case 'number':
      return decimal(field, raw, 0);
    case 'percent':
    case 'currency':
      return decimal(field, raw, 2);
    case 'date':
      return date(raw);
    case 'datetime':
      return datetime(raw);
    case 'time':
      if (typeof raw !== 'string') return fail('invalid_type');
      return TIME.test(raw) ? ok(raw.length === 5 ? `${raw}:00` : raw) : fail('invalid_format');
    case 'checkbox':
      return typeof raw === 'boolean' ? ok(raw) : fail('invalid_type');
    case 'picklist':
      if (typeof raw !== 'string') return fail('invalid_type');
      return allowed.includes(raw) ? ok(raw) : fail('not_in_picklist');
    case 'multi_picklist': {
      if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string'))
        return fail('invalid_type');
      const values = [...new Set(raw as string[])];
      if (values.some((v) => !allowed.includes(v))) return fail('not_in_picklist');
      return ok(values.length ? values : null);
    }
    case 'lookup':
    case 'master_detail':
    case 'user':
      if (typeof raw !== 'string') return fail('invalid_type');
      return UUID.test(raw) ? ok(raw.toLowerCase()) : fail('invalid_format');
    case 'geolocation': {
      if (typeof raw !== 'object') return fail('invalid_type');
      const { lat, lng } = raw as { lat?: unknown; lng?: unknown };
      if (typeof lat !== 'number' || typeof lng !== 'number') return fail('invalid_type');
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return fail('out_of_range');
      return ok({ lat, lng });
    }
    default:
      return fail('read_only');
  }
}

/** Types a list view can sort by (long and rich text, multi-selects and geolocation cannot). */
export function isSortable(type: FieldType): boolean {
  return !['long_text', 'rich_text', 'multi_picklist', 'geolocation', 'formula'].includes(type);
}
