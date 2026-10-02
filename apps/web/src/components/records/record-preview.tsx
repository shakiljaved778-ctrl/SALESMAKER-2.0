'use client';

import { Button, FieldValue } from '@sm/ui';
import { MousePointerClick } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import {
  cellValue,
  picklistOptions,
  recordName,
  uiType,
  type DescribedObject,
  type RecordRow,
} from './fields';
import { useRecordLabels } from './use-record-labels';

/** Split view (§9.11 T1): the focused record's list columns beside the list. */
export function RecordPreview({
  object,
  row,
  columns,
  href,
  locale,
  timeZone,
}: {
  object: DescribedObject | null;
  row: RecordRow | null;
  columns: string[];
  href: string | null;
  locale: string | undefined;
  timeZone: string | undefined;
}) {
  const t = useTranslations('records.list');
  const labels = useRecordLabels();
  if (!object || !row)
    return (
      <aside
        aria-label={t('splitView')}
        className="grid w-[360px] shrink-0 place-items-center rounded-md border border-dashed border-line p-6 text-center"
      >
        <div className="grid justify-items-center gap-2 text-fg-secondary">
          <MousePointerClick aria-hidden className="size-5" />
          <p className="text-body-sm">{t('splitEmpty')}</p>
        </div>
      </aside>
    );
  const fields = new Map(object.fields.map((f) => [f.name, f]));
  return (
    <aside
      aria-label={t('splitView')}
      className="flex w-[360px] shrink-0 flex-col gap-4 overflow-auto rounded-md border border-line bg-surface p-4 shadow-e1"
    >
      <div>
        <p className="text-caption text-fg-secondary">{object.label}</p>
        <h2 className="text-title-2 text-fg">{recordName(object, row)}</h2>
      </div>
      <dl className="grid gap-3">
        {columns.map((name) => {
          const field = fields.get(name);
          if (!field) return null;
          const { value, currencyCode } = cellValue(row[name]);
          return (
            <div key={name}>
              <dt className="text-caption text-fg-secondary">{field.label}</dt>
              <dd>
                <FieldValue
                  type={uiType(field.type)}
                  value={value}
                  currencyCode={currencyCode}
                  options={picklistOptions(field)}
                  labels={labels.value}
                  locale={locale}
                  timeZone={timeZone}
                />
              </dd>
            </div>
          );
        })}
      </dl>
      {href ? (
        <Button variant="primary" asChild className="self-start">
          <Link href={href} prefetch={false}>
            {t('open')}
          </Link>
        </Button>
      ) : null}
    </aside>
  );
}
