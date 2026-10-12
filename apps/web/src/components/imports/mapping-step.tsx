'use client';

import { Button, Dialog, Input, Select } from '@sm/ui';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import type { DescribedField, DescribedObject } from '../records/fields';
import { DATE_TYPES, PICKLIST_TYPES, type ColumnMapping } from './types';

/** One column's choice; `field: ''` leaves the column out. */
export type ColumnChoice = Omit<ColumnMapping, 'column'>;

const SKIP = '__skip';
const AUTO = '__auto';
/** Pseudo-field for a row's currency (ISO code), on objects with money fields. */
export const CURRENCY = 'currency_code';

/** A copy of `obj` without `key` (optional properties stay absent, not undefined). */
function without<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key)) as Omit<T, K>;
}

/** Columns' choices as the API's mapping (left-out columns dropped). */
export function toMapping(choices: readonly ColumnChoice[]): ColumnMapping[] {
  return choices.flatMap((c, column) => (c.field ? [{ ...c, column }] : []));
}

/** The API's mapping as one choice per column. */
export function fromMapping(mapping: readonly ColumnMapping[], width: number): ColumnChoice[] {
  return Array.from({ length: width }, (_, column) => {
    const m = mapping.find((x) => x.column === column);
    if (!m) return { field: '' };
    return without(m, 'column');
  });
}

export function MappingStep({
  headers,
  sample,
  describe,
  choices,
  onChange,
}: {
  headers: string[];
  sample: string[][];
  describe: DescribedObject;
  choices: ColumnChoice[];
  onChange: (next: ColumnChoice[]) => void;
}) {
  const t = useTranslations('imports.mapping');
  const [valuesFor, setValuesFor] = useState<number | null>(null);
  const editable = useMemo(
    () => describe.fields.filter((f) => f.editable).sort((a, b) => a.label.localeCompare(b.label)),
    [describe],
  );
  const hasMoney = describe.fields.some((f) => f.type === 'currency');
  const fieldOf = (name: string): DescribedField | undefined =>
    describe.fields.find((f) => f.name === name);
  const used = new Set(choices.map((c) => c.field).filter(Boolean));
  const set = (i: number, next: ColumnChoice) => {
    onChange(choices.map((c, j) => (j === i ? next : c)));
  };
  const example = (i: number) => sample.map((r) => r[i] ?? '').find((v) => v !== '') ?? '';

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <table className="w-full table-fixed border-collapse text-body-sm">
        <caption className="sr-only">{t('caption')}</caption>
        <thead>
          <tr className="border-b border-line text-start text-caption text-fg-secondary">
            <th scope="col" className="w-1/4 py-2 pe-3 text-start font-medium">
              {t('column')}
            </th>
            <th scope="col" className="w-1/4 py-2 pe-3 text-start font-medium">
              {t('example')}
            </th>
            <th scope="col" className="py-2 text-start font-medium">
              {t('field')}
            </th>
          </tr>
        </thead>
        <tbody>
          {headers.map((header, i) => {
            const choice = choices[i] ?? { field: '' };
            const field = choice.field ? fieldOf(choice.field) : undefined;
            const options = [
              { value: SKIP, label: t('skip') },
              ...(hasMoney && (!used.has(CURRENCY) || choice.field === CURRENCY)
                ? [{ value: CURRENCY, label: t('currency') }]
                : []),
              ...editable
                .filter((f) => !used.has(f.name) || f.name === choice.field)
                .map((f) => ({ value: f.name, label: f.label })),
            ];
            return (
              <tr key={`${String(i)}-${header}`} className="border-b border-line-subtle align-top">
                <th scope="row" className="py-2 pe-3 text-start font-medium text-fg">
                  <span className="block truncate" title={header}>
                    {header || t('untitled', { n: i + 1 })}
                  </span>
                </th>
                <td className="py-2 pe-3 text-fg-secondary">
                  <span className="block truncate" title={example(i)}>
                    {example(i)}
                  </span>
                </td>
                <td className="flex flex-col gap-2 py-2">
                  <Select
                    aria-label={t('fieldFor', { column: header || String(i + 1) })}
                    options={options}
                    value={choice.field || SKIP}
                    onValueChange={(v) => {
                      set(i, v === SKIP ? { field: '' } : { field: v });
                    }}
                  />
                  {field && DATE_TYPES.has(field.type) ? (
                    <Select
                      aria-label={t('dateOrder')}
                      options={[
                        { value: AUTO, label: t('dateIso') },
                        { value: 'DMY', label: t('dateDmy') },
                        { value: 'MDY', label: t('dateMdy') },
                        { value: 'YMD', label: t('dateYmd') },
                      ]}
                      value={choice.dateOrder ?? AUTO}
                      onValueChange={(v) => {
                        const rest = without(choice, 'dateOrder');
                        set(i, v === AUTO ? rest : { ...rest, dateOrder: v as 'DMY' });
                      }}
                    />
                  ) : null}
                  {field?.type === 'phone' ? (
                    <Input
                      aria-label={t('phoneCountry')}
                      placeholder={t('phoneCountryPlaceholder')}
                      value={choice.phoneCountry ?? ''}
                      onChange={(e) => {
                        const v = e.target.value.trim();
                        const rest = without(choice, 'phoneCountry');
                        set(i, v ? { ...rest, phoneCountry: v } : rest);
                      }}
                    />
                  ) : null}
                  {choice.field === 'owner_id' ? (
                    <Select
                      aria-label={t('ownerBy')}
                      options={[
                        { value: 'email', label: t('ownerByEmail') },
                        { value: 'name', label: t('ownerByName') },
                        { value: 'id', label: t('ownerById') },
                      ]}
                      value={choice.ownerBy ?? 'email'}
                      onValueChange={(v) => {
                        set(i, { ...choice, ownerBy: v as 'email' });
                      }}
                    />
                  ) : null}
                  {field && PICKLIST_TYPES.has(field.type) ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="self-start"
                      onClick={() => {
                        setValuesFor(i);
                      }}
                    >
                      {t('mapValues', { n: Object.keys(choice.values ?? {}).length })}
                    </Button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <aside
        aria-label={t('preview')}
        className="flex flex-col gap-2 self-start rounded-md border border-line bg-subtle p-4"
      >
        <h3 className="text-label text-fg">{t('preview')}</h3>
        <p className="text-caption text-fg-secondary">{t('previewHint')}</p>
        <dl className="flex flex-col gap-2 text-body-sm">
          {choices.flatMap((c, i) =>
            c.field
              ? [
                  <div key={c.field} className="min-w-0">
                    <dt className="text-caption text-fg-secondary">
                      {c.field === CURRENCY ? t('currency') : (fieldOf(c.field)?.label ?? c.field)}
                    </dt>
                    <dd className="truncate text-fg">{sample[0]?.[i] || '—'}</dd>
                  </div>,
                ]
              : [],
          )}
        </dl>
      </aside>

      {valuesFor !== null ? (
        <ValuesDialog
          header={headers[valuesFor] ?? ''}
          seen={[...new Set(sample.map((r) => r[valuesFor] ?? '').filter(Boolean))]}
          field={fieldOf(choices[valuesFor]?.field ?? '')}
          values={choices[valuesFor]?.values ?? {}}
          onClose={(values) => {
            const choice = choices[valuesFor] ?? { field: '' };
            if (values) {
              const rest = without(choice, 'values');
              set(valuesFor, Object.keys(values).length ? { ...rest, values } : rest);
            }
            setValuesFor(null);
          }}
        />
      ) : null}
    </div>
  );
}

/** Picklist values: what the file says → the value it means (labels already match by themselves). */
function ValuesDialog({
  header,
  seen,
  field,
  values,
  onClose,
}: {
  header: string;
  seen: string[];
  field: DescribedField | undefined;
  values: Record<string, string>;
  onClose: (values: Record<string, string> | null) => void;
}) {
  const t = useTranslations('imports.mapping');
  const tc = useTranslations('common.actions');
  const [draft, setDraft] = useState<Record<string, string>>(values);
  const [extra, setExtra] = useState('');
  const keys = [...new Set([...seen, ...Object.keys(draft)])];
  const options = [
    { value: AUTO, label: t('valueAsWritten') },
    ...(field?.picklistValues ?? []).map((v) => ({ value: v.value, label: v.label })),
  ];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose(null);
      }}
      title={t('valuesTitle', { column: header })}
      description={t('valuesHint')}
      closeLabel={tc('close')}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              onClose(null);
            }}
          >
            {tc('cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onClose(draft);
            }}
          >
            {tc('save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {keys.map((k) => (
          <div key={k} className="grid grid-cols-2 items-center gap-3">
            <span className="truncate text-body-sm text-fg">{k}</span>
            <Select
              aria-label={t('valueFor', { value: k })}
              options={options}
              value={draft[k] ?? AUTO}
              onValueChange={(v) => {
                setDraft((d) => {
                  const next = { ...d };
                  if (v === AUTO)
                    return Object.fromEntries(Object.entries(next).filter(([x]) => x !== k));
                  next[k] = v;
                  return next;
                });
              }}
            />
          </div>
        ))}
        <div className="flex items-end gap-2">
          <Input
            aria-label={t('otherValue')}
            placeholder={t('otherValue')}
            value={extra}
            onChange={(e) => {
              setExtra(e.target.value);
            }}
          />
          <Button
            variant="secondary"
            disabled={!extra.trim()}
            onClick={() => {
              const k = extra.trim();
              const first = field?.picklistValues?.[0]?.value;
              if (first) setDraft((d) => ({ ...d, [k]: d[k] ?? first }));
              setExtra('');
            }}
          >
            {t('addValue')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
