import type { FieldMeta, ObjectMeta } from '@sm/metadata';
import type { FieldError, WriteInput } from '@sm/records';

/*
 * Column mapping (§7.1): which file column feeds which field, and how its text becomes a value:
 * picklist value maps, date orders, a default phone country, owners by email or name, numbers
 * with thousands separators, checkboxes in words. What cannot be turned into a value is a row
 * error; RecordService then checks the rest as for any write.
 */

export interface ColumnMapping {
  /** Index of the column in the file (0-based). */
  column: number;
  /** The field it fills, or `currency_code` for the row's currency. */
  field: string;
  /** Picklists: file value (any case) → API value. */
  values?: Record<string, string>;
  /** Dates: the order of day, month and year in the file (ISO dates always work). */
  dateOrder?: 'DMY' | 'MDY' | 'YMD';
  /** Phones written without a country code get this one, e.g. `+974`. */
  phoneCountry?: string;
  /** owner_id: find the user by email or name (else the column holds user ids). */
  ownerBy?: 'email' | 'name' | 'id';
}

export interface MappedRow {
  rowNumber: number;
  input: WriteInput;
  errors: FieldError[];
  /** Owners still to resolve: by email or name, lower case. */
  owner?: { by: 'email' | 'name'; key: string };
}

const blank = (s: string | undefined) => s === undefined || s.trim() === '';
const TRUE = new Set(['true', 'yes', 'y', '1', 'x', 'on', 'checked']);
const FALSE = new Set(['false', 'no', 'n', '0', 'off', '']);

/** `1,234.56`, `1.234,56`, `1 234`, `$1,200`, `12%` → a plain decimal (null when not a number). */
export function normaliseNumber(raw: string): string | null {
  let s = raw
    .replace(/[\s\u00a0'’]/g, '')
    .replace(/%$/, '')
    .replace(/^[^\d+\-.,]+|[^\d.,]+$/g, '');
  const sign = s.startsWith('-') ? '-' : '';
  s = s.replace(/^[+-]/, '');
  if (!/^[\d.,]+$/.test(s)) return null;
  const comma = s.includes(',');
  const dot = s.includes('.');
  if (comma && dot) {
    // The separator that comes last is the decimal one.
    s =
      s.lastIndexOf(',') > s.lastIndexOf('.')
        ? s.replace(/\./g, '').replace(',', '.')
        : s.replace(/,/g, '');
  } else if (comma) {
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (dot && /^\d{1,3}(\.\d{3}){2,}$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  return /^(\d+\.?\d*|\.\d+)$/.test(s) ? `${sign}${s}` : null;
}

/** A date in the given order (or ISO) as `YYYY-MM-DD`; null when it is not one. */
export function normaliseDate(
  raw: string,
  order: ColumnMapping['dateOrder'] = 'YMD',
): string | null {
  const s = raw.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/.exec(s);
  let y: number;
  let m: number;
  let d: number;
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else {
    const parts = s.split(/[/.\-\s]+/).map(Number);
    if (parts.length !== 3 || parts.some((p) => !Number.isInteger(p))) return null;
    const [a = 0, b = 0, c = 0] = parts;
    [y, m, d] = order === 'DMY' ? [c, b, a] : order === 'MDY' ? [c, a, b] : [a, b, c];
    if (y < 100) y += y < 50 ? 2000 : 1900;
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d)
    return null;
  return date.toISOString().slice(0, 10);
}

/** A phone with the default country when it has none (`5550 1234` → `+974 5550 1234`). */
export function withCountry(raw: string, country?: string): string {
  const s = raw.trim();
  if (!country || /^(\+|00)/.test(s)) return s;
  return `${country} ${s.replace(/^0+/, '')}`;
}

function picklistValue(f: FieldMeta, raw: string, map?: Record<string, string>): string {
  const key = raw.trim().toLowerCase();
  const mapped = Object.entries(map ?? {}).find(([k]) => k.trim().toLowerCase() === key)?.[1];
  if (mapped !== undefined) return mapped;
  const known = f.picklistValues.find(
    (v) => v.apiValue.toLowerCase() === key || (v.label ?? '').toLowerCase() === key,
  );
  return known?.apiValue ?? raw.trim();
}

/** One cell as the value its field takes; an error code when it cannot be one. */
function convert(
  f: FieldMeta,
  raw: string,
  m: ColumnMapping,
): { value: unknown } | { error: string } {
  switch (f.type) {
    case 'number':
    case 'currency':
    case 'percent': {
      const n = normaliseNumber(raw);
      return n === null ? { error: 'invalid_number' } : { value: n };
    }
    case 'date': {
      const d = normaliseDate(raw, m.dateOrder);
      return d === null ? { error: 'invalid_date' } : { value: d };
    }
    case 'datetime': {
      const s = raw.trim();
      if (/^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s)))
        return { value: new Date(s).toISOString() };
      const d = normaliseDate(s, m.dateOrder);
      return d === null ? { error: 'invalid_date' } : { value: `${d}T00:00:00.000Z` };
    }
    case 'checkbox': {
      const v = raw.trim().toLowerCase();
      return TRUE.has(v)
        ? { value: true }
        : FALSE.has(v)
          ? { value: false }
          : { error: 'invalid_checkbox' };
    }
    case 'picklist':
      return { value: picklistValue(f, raw, m.values) };
    case 'multi_picklist':
      return {
        value: raw
          .split(/[;,]/)
          .map((v) => v.trim())
          .filter(Boolean)
          .map((v) => picklistValue(f, v, m.values)),
      };
    case 'phone':
      return { value: withCountry(raw, m.phoneCountry) };
    default:
      return { value: raw.trim() };
  }
}

/**
 * One file row as a write: mapped cells converted, blanks left out (defaults then apply), the
 * job's default values filling fields the row leaves empty.
 */
export function mapRow(
  object: ObjectMeta,
  mapping: readonly ColumnMapping[],
  cells: readonly string[],
  rowNumber: number,
  defaults: Readonly<Record<string, unknown>> = {},
): MappedRow {
  const fields: Record<string, unknown> = {};
  const errors: FieldError[] = [];
  let currencyCode: string | undefined;
  let owner: MappedRow['owner'];
  for (const m of mapping) {
    const raw = cells[m.column];
    if (blank(raw)) continue;
    const text = (raw ?? '').trim();
    if (m.field === 'currency_code') {
      currencyCode = text.toUpperCase();
      continue;
    }
    if (m.field === 'owner_id' && m.ownerBy && m.ownerBy !== 'id') {
      owner = { by: m.ownerBy, key: text.toLowerCase() };
      continue;
    }
    const f = object.fields.find((x) => x.apiName === m.field);
    if (!f) {
      errors.push({ field: m.field, code: 'unknown_field' });
      continue;
    }
    const out = convert(f, text, m);
    if ('error' in out) errors.push({ field: m.field, code: out.error });
    else fields[m.field] = out.value;
  }
  for (const [field, value] of Object.entries(defaults))
    if (field === 'currency_code') currencyCode ??= String(value);
    else if (fields[field] === undefined && value !== null && value !== '') fields[field] = value;
  return {
    rowNumber,
    input: { fields, ...(currencyCode ? { currencyCode } : {}) },
    errors,
    ...(owner ? { owner } : {}),
  };
}

const SYNONYMS: Record<string, string[]> = {
  first_name: ['first name', 'firstname', 'given name', 'forename'],
  last_name: ['last name', 'lastname', 'surname', 'family name'],
  company: ['company', 'company name', 'organisation', 'organization', 'account', 'business'],
  name: ['name', 'account name', 'company name'],
  email: ['email', 'e-mail', 'email address', 'e-mail address', 'mail'],
  phone: ['phone', 'phone number', 'telephone', 'tel', 'work phone', 'office phone'],
  mobile_phone: ['mobile', 'mobile phone', 'cell', 'cell phone', 'whatsapp'],
  title: ['title', 'job title', 'position', 'role'],
  website: ['website', 'web site', 'url', 'site'],
  city: ['city', 'town'],
  country: ['country'],
  lead_source: ['source', 'lead source'],
  owner_id: ['owner', 'lead owner', 'owner email', 'assigned to'],
  annual_revenue: ['revenue', 'annual revenue'],
  number_of_employees: ['employees', 'number of employees', 'headcount', 'company size'],
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Suggested mappings for a file's headers (T18): exact API names, labels and common synonyms,
 * each field used once. `labels` are the fields' display labels in the user's language.
 */
export function suggestMappings(
  object: ObjectMeta,
  headers: readonly string[],
  labels: Readonly<Record<string, string>> = {},
): ColumnMapping[] {
  const writable = object.fields.filter(
    (f) => !f.system && f.type !== 'auto_number' && f.type !== 'formula',
  );
  const used = new Set<string>();
  const out: ColumnMapping[] = [];
  for (const [column, header] of headers.entries()) {
    const h = norm(header);
    if (!h) continue;
    const candidates = writable.filter((f) => !used.has(f.apiName));
    const match =
      candidates.find((f) => norm(f.apiName) === h) ??
      candidates.find((f) => norm(labels[f.apiName] ?? '') === h) ??
      candidates.find((f) => (SYNONYMS[f.apiName] ?? []).map(norm).includes(h));
    if (!match) continue;
    used.add(match.apiName);
    out.push({
      column,
      field: match.apiName,
      ...(match.apiName === 'owner_id' ? { ownerBy: h.includes('email') ? 'email' : 'name' } : {}),
    });
  }
  return out;
}

/** A stable signature of a header row, to find saved mapping templates for the same layout. */
export function headersSignature(headers: readonly string[]): string {
  return headers.map(norm).join('|');
}
