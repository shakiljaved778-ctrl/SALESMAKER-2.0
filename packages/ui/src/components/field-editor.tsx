'use client';

import type { ReactNode } from 'react';

import { cn } from '../lib/cn.js';
import { Checkbox } from './choice.js';
import { Combobox, type ComboboxOption } from './combobox.js';
import type { FieldType, LookupValue, PicklistValue } from './field-value.js';
import { useFormField } from './form-field.js';
import { Input, Textarea } from './input.js';
import { Select } from './select.js';

/** The value an editor emits: strings for text, decimals and dates; arrays for multi-picklists. */
export type FieldEditorValue = string | boolean | string[] | LookupValue | null;

export interface FieldEditorLabels {
  /** Placeholder of an empty picklist / lookup. */
  select: string;
  /** The picklist option that clears the value. */
  none: string;
  /** Lookup search box placeholder and its empty result text. */
  search: string;
  noResults: string;
  searching: string;
}

export interface LookupSearch {
  /** Current results; the selected record is kept in the list automatically. */
  results: LookupValue[];
  /** Called (debounced by the combobox) as the user types. */
  onSearch: (query: string) => void;
  loading?: boolean | undefined;
  /** Secondary line under a result (e.g. the account of a contact). */
  describe?: ((value: LookupValue) => string | undefined) | undefined;
  icon?: ((object: string) => ReactNode) | undefined;
}

export interface FieldEditorProps {
  type: FieldType;
  value: FieldEditorValue | undefined;
  onChange: (value: FieldEditorValue) => void;
  labels: FieldEditorLabels;
  /** Accessible name when the editor is not inside a FormField (e.g. inline grid edit). */
  'aria-label'?: string | undefined;
  options?: PicklistValue[] | undefined;
  lookup?: LookupSearch | undefined;
  /** ISO-4217 code shown as the prefix of a currency input. */
  currencyCode?: string | undefined;
  maxLength?: number | undefined;
  disabled?: boolean | undefined;
  className?: string;
}

const NONE = '__none__';

/** A decimal as typed: digits, an optional sign and one point. Grouping is never accepted in input. */
const DECIMAL_DRAFT = /^-?\d*(\.\d*)?$/;

function str(value: FieldEditorValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

/** `YYYY-MM-DDTHH:mm` in the browser's zone, for datetime-local. */
function toLocalInput(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** Editor for one field value, per type (§9.10 inputs). Datetimes are emitted as UTC ISO strings. */
export function FieldEditor({
  type,
  value,
  onChange,
  labels,
  options = [],
  lookup,
  currencyCode,
  maxLength,
  disabled,
  className,
  'aria-label': ariaLabel,
}: FieldEditorProps) {
  const field = useFormField();
  const common = { disabled, 'aria-label': field ? undefined : ariaLabel, className };

  switch (type) {
    case 'long_text':
      return (
        <Textarea
          {...common}
          rows={4}
          value={str(value)}
          maxLength={maxLength}
          showCount={maxLength !== undefined}
          onChange={(e) => {
            onChange(e.target.value === '' ? null : e.target.value);
          }}
        />
      );
    case 'number':
    case 'percent':
    case 'currency':
      return (
        <Input
          {...common}
          inputMode="decimal"
          className={cn('text-end tabular-nums [&_input]:text-end', className)}
          value={str(value)}
          prefix={
            type === 'currency' ? (
              <span className="text-fg-tertiary">{currencyCode}</span>
            ) : undefined
          }
          suffix={type === 'percent' ? <span className="text-fg-tertiary">%</span> : undefined}
          onChange={(e) => {
            const v = e.target.value.trim();
            if (DECIMAL_DRAFT.test(v)) onChange(v === '' ? null : v);
          }}
        />
      );
    case 'date':
      return (
        <Input
          {...common}
          type="date"
          value={str(value)}
          onChange={(e) => {
            onChange(e.target.value === '' ? null : e.target.value);
          }}
        />
      );
    case 'datetime':
      return (
        <Input
          {...common}
          type="datetime-local"
          value={toLocalInput(str(value))}
          onChange={(e) => {
            const at = new Date(e.target.value);
            onChange(Number.isNaN(at.getTime()) ? null : at.toISOString());
          }}
        />
      );
    case 'checkbox':
      return (
        <Checkbox
          id={field?.id}
          aria-label={field ? undefined : ariaLabel}
          aria-describedby={field?.describedBy}
          disabled={disabled ?? field?.disabled}
          checked={value === true}
          onCheckedChange={(c) => {
            onChange(c === true);
          }}
        />
      );
    case 'picklist':
      return (
        <Select
          className={className}
          disabled={disabled}
          placeholder={labels.select}
          options={[{ value: NONE, label: labels.none }, ...options]}
          value={str(value) || NONE}
          onValueChange={(v) => {
            onChange(v === NONE ? null : v);
          }}
          {...(ariaLabel && !field ? { 'aria-label': ariaLabel } : {})}
        />
      );
    case 'multi_picklist': {
      const selected = new Set(Array.isArray(value) ? value : []);
      return (
        <div
          role="group"
          aria-label={field ? undefined : ariaLabel}
          aria-labelledby={field ? `${field.id}-label` : undefined}
          className={cn('grid gap-1.5 py-1', className)}
        >
          {options.map((o) => (
            <Checkbox
              key={o.value}
              label={o.label}
              disabled={disabled ?? field?.disabled}
              checked={selected.has(o.value)}
              onCheckedChange={(c) => {
                const next = new Set(selected);
                if (c === true) next.add(o.value);
                else next.delete(o.value);
                // Keep the option order, not the click order.
                const ordered = options.map((x) => x.value).filter((v) => next.has(v));
                onChange(ordered.length ? ordered : null);
              }}
            />
          ))}
        </div>
      );
    }
    case 'lookup': {
      const current = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
      const results = lookup?.results ?? [];
      const all =
        current && !results.some((r) => r.id === current.id) ? [current, ...results] : results;
      const comboOptions: ComboboxOption[] = all.map((r) => ({
        value: r.id,
        label: r.name,
        ...(lookup?.describe?.(r) ? { description: lookup.describe(r) } : {}),
        ...(lookup?.icon ? { icon: lookup.icon(r.object) } : {}),
      }));
      return (
        <Combobox
          className={className}
          disabled={disabled}
          options={comboOptions}
          value={current?.id}
          placeholder={labels.select}
          searchPlaceholder={labels.search}
          emptyText={labels.noResults}
          loadingText={labels.searching}
          loading={lookup?.loading}
          {...(lookup ? { onSearch: lookup.onSearch } : {})}
          onValueChange={(id) => {
            onChange(all.find((r) => r.id === id) ?? null);
          }}
        />
      );
    }
    case 'email':
    case 'phone':
    case 'url':
    case 'text':
      return (
        <Input
          {...common}
          type={
            type === 'email' ? 'email' : type === 'phone' ? 'tel' : type === 'url' ? 'url' : 'text'
          }
          dir={type === 'text' ? undefined : 'ltr'}
          value={str(value)}
          maxLength={maxLength}
          onChange={(e) => {
            onChange(e.target.value === '' ? null : e.target.value);
          }}
        />
      );
  }
}
