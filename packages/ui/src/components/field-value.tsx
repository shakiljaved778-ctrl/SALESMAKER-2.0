'use client';

import { Check, ExternalLink, Minus } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn.js';
import { HoverCard } from './overlays.js';
import { StatusChip, type StatusChipProps } from './status-chip.js';
import { Tooltip } from './tooltip.js';

/** Field types the record components render and edit (§5.3 metadata field types). */
export type FieldType =
  | 'text'
  | 'long_text'
  | 'number'
  | 'percent'
  | 'currency'
  | 'date'
  | 'datetime'
  | 'picklist'
  | 'multi_picklist'
  | 'lookup'
  | 'phone'
  | 'email'
  | 'url'
  | 'checkbox';

/** A lookup as the records API returns it. */
export interface LookupValue {
  id: string;
  name: string;
  object: string;
}

export interface PicklistValue {
  value: string;
  label: string;
  tone?: StatusChipProps['tone'];
}

export interface FieldValueLabels {
  /** Shown for an empty value (usually an em dash). */
  empty: string;
  yes: string;
  no: string;
  /** Screen-reader suffix for links that open a new tab. */
  opensInNewTab: string;
}

export interface FieldFormat {
  /** BCP 47 locale for numbers and dates. */
  locale?: string | undefined;
  /** IANA zone date-times are shown in; date-only values never shift. */
  timeZone?: string | undefined;
  /** ISO-4217 code for currency values. */
  currencyCode?: string | undefined;
  /** Decimal places for number, percent and currency. */
  scale?: number | undefined;
  /** The reference instant for relative dates; defaults to now. */
  now?: Date | undefined;
}

export interface FieldValueProps extends FieldFormat {
  type: FieldType;
  value: unknown;
  labels: FieldValueLabels;
  /** Picklist values with their labels and chip tones; unknown values render as raw text. */
  options?: PicklistValue[] | undefined;
  /** Where a lookup chip links to. */
  lookupHref?: ((value: LookupValue) => string | undefined) | undefined;
  /** Optional hover card body for a lookup chip (the compact layout of the target). */
  lookupCard?: ((value: LookupValue) => ReactNode) | undefined;
  /** Optional icon for a lookup chip by object API name. */
  lookupIcon?: ((object: string) => ReactNode) | undefined;
  className?: string;
}

const DAY = 86_400_000;
const RELATIVE_WITHIN_DAYS = 7;

/** A decimal string as Intl accepts it, so money is formatted without a float round trip (§0.4 rule 8). */
function decimal(value: unknown): `${number}` | null {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value}`;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim()))
    return value.trim() as `${number}`;
  return null;
}

export function formatNumber(
  type: 'number' | 'percent' | 'currency',
  value: unknown,
  { locale, currencyCode, scale }: FieldFormat = {},
): string | null {
  const n = decimal(value);
  if (n === null) return null;
  const digits =
    scale === undefined ? {} : { minimumFractionDigits: scale, maximumFractionDigits: scale };
  if (type === 'currency' && currencyCode)
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currencyCode,
      ...digits,
    }).format(n);
  // Percent values are stored as the percentage itself (12.5 means 12.5%), never as a ratio.
  if (type === 'percent')
    return new Intl.NumberFormat(locale, { style: 'unit', unit: 'percent', ...digits }).format(n);
  return new Intl.NumberFormat(locale, digits).format(n);
}

/** Today's calendar date in a zone, as YYYY-MM-DD. */
function calendarDate(at: Date, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

function parseDateOnly(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export interface FormattedDate {
  /** What is shown: relative within a week, absolute otherwise. */
  text: string;
  /** The absolute form, for the tooltip and `dateTime`. */
  absolute: string;
  iso: string;
  relative: boolean;
}

export function formatDate(
  type: 'date' | 'datetime',
  value: unknown,
  { locale, timeZone, now = new Date() }: FieldFormat = {},
): FormattedDate | null {
  if (typeof value !== 'string') return null;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  if (type === 'date') {
    // Business dates are calendar days: they never shift with the viewer's zone (§0.4 rule 9).
    const day = parseDateOnly(value);
    const today = parseDateOnly(calendarDate(now, timeZone));
    if (day === null || today === null) return null;
    const absolute = new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeZone: 'UTC',
    }).format(day);
    const days = Math.round((day - today) / DAY);
    const relative = Math.abs(days) < RELATIVE_WITHIN_DAYS;
    return { text: relative ? rtf.format(days, 'day') : absolute, absolute, iso: value, relative };
  }
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  const absolute = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(at);
  const diff = at - now.getTime();
  const abs = Math.abs(diff);
  if (abs >= RELATIVE_WITHIN_DAYS * DAY)
    return { text: absolute, absolute, iso: value, relative: false };
  const text =
    abs < 3_600_000
      ? rtf.format(Math.round(diff / 60_000), 'minute')
      : abs < DAY
        ? rtf.format(Math.round(diff / 3_600_000), 'hour')
        : rtf.format(Math.round(diff / DAY), 'day');
  return { text, absolute, iso: value, relative: true };
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function isLookup(value: unknown): value is LookupValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<LookupValue>).id === 'string' &&
    typeof (value as Partial<LookupValue>).name === 'string'
  );
}

function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

const linkClass = 'text-link underline-offset-4 hover:underline focus-visible:underline';

/** The lookup chip (§9.10 "Lookup field"): links to the record, with the compact layout on hover. */
export function LookupChip({
  value,
  href,
  card,
  icon,
}: {
  value: LookupValue;
  href?: string | undefined;
  card?: ReactNode;
  icon?: ReactNode;
}) {
  const chip = (
    <a
      href={href}
      className="inline-flex h-6 max-w-full items-center gap-1 rounded-xs border border-line bg-subtle px-1.5 text-body-sm text-link hover:bg-hover [&_svg]:size-3.5 [&_svg]:shrink-0"
    >
      {icon}
      <span className="truncate">{value.name}</span>
    </a>
  );
  return card ? <HoverCard trigger={chip}>{card}</HoverCard> : chip;
}

/** Read-only renderer for one field value, per type (§9.10 column-type formatting). */
export function FieldValue({
  type,
  value,
  labels,
  options,
  lookupHref,
  lookupCard,
  lookupIcon,
  className,
  ...format
}: FieldValueProps) {
  const wrap = (node: ReactNode) => (
    <span className={cn('min-w-0 text-body text-fg', className)}>{node}</span>
  );
  if (type === 'checkbox') {
    const on = value === true;
    return wrap(
      <span className="inline-flex items-center gap-1 [&_svg]:size-4">
        {on ? (
          <Check aria-hidden className="text-success" />
        ) : (
          <Minus aria-hidden className="text-fg-tertiary" />
        )}
        {on ? labels.yes : labels.no}
      </span>,
    );
  }
  if (isEmpty(value)) return wrap(<span className="text-fg-tertiary">{labels.empty}</span>);

  switch (type) {
    case 'number':
    case 'percent':
    case 'currency': {
      const text = formatNumber(type, value, format);
      return wrap(<span className="tabular-nums">{text ?? asText(value)}</span>);
    }
    case 'date':
    case 'datetime': {
      const d = formatDate(type, value, format);
      if (!d) return wrap(asText(value));
      const time = (
        <time dateTime={d.iso}>
          <bdi>{d.text}</bdi>
        </time>
      );
      return wrap(d.relative ? <Tooltip content={d.absolute}>{time}</Tooltip> : time);
    }
    case 'picklist': {
      const v = asText(value);
      const option = options?.find((o) => o.value === v);
      return wrap(<StatusChip tone={option?.tone ?? 'neutral'}>{option?.label ?? v}</StatusChip>);
    }
    case 'multi_picklist': {
      const values = Array.isArray(value) ? value.map(asText) : asText(value).split(';');
      return wrap(
        <span className="inline-flex flex-wrap gap-1">
          {values.map((v) => {
            const option = options?.find((o) => o.value === v);
            return (
              <StatusChip key={v} tone={option?.tone ?? 'neutral'}>
                {option?.label ?? v}
              </StatusChip>
            );
          })}
        </span>,
      );
    }
    case 'lookup':
      if (!isLookup(value)) return wrap(<span className="text-fg-tertiary">{labels.empty}</span>);
      return wrap(
        <LookupChip
          value={value}
          href={lookupHref?.(value)}
          card={lookupCard?.(value)}
          icon={lookupIcon?.(value.object)}
        />,
      );
    case 'phone': {
      const v = asText(value);
      return wrap(
        <a className={linkClass} href={`tel:${v.replace(/[^\d+]/g, '')}`}>
          <bdi>{v}</bdi>
        </a>,
      );
    }
    case 'email': {
      const v = asText(value);
      return wrap(
        <a className={linkClass} href={`mailto:${v}`}>
          <bdi>{v}</bdi>
        </a>,
      );
    }
    case 'url': {
      const v = asText(value);
      const href = /^https?:\/\//i.test(v) ? v : `https://${v}`;
      return wrap(
        <a
          className={cn(linkClass, 'inline-flex items-center gap-1 [&_svg]:size-3.5')}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
        >
          <bdi className="truncate">{v.replace(/^https?:\/\//i, '')}</bdi>
          <ExternalLink aria-hidden />
          <span className="sr-only">{labels.opensInNewTab}</span>
        </a>,
      );
    }
    case 'long_text':
      return wrap(<span className="whitespace-pre-line">{asText(value)}</span>);
    default:
      return wrap(asText(value));
  }
}
