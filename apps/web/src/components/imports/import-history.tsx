'use client';

import { Banner, EmptyState, Skeleton, StatusChip } from '@sm/ui';
import { History } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { cellApi } from '../../lib/cell-api';
import { sectionForObject } from '../records/fields';
import { STATUS_TONE } from './import-progress';
import { statusKey, type ImportJob } from './types';

/**
 * Import history (§7.1): the caller's imports, or everyone's for Setup viewers (`all`). Each opens
 * in the wizard, which shows its outcome and offers undo.
 */
export function ImportHistory({ object, all = false }: { object?: string; all?: boolean }) {
  const t = useTranslations('imports.history');
  const ts = useTranslations('imports.status');
  const format = useFormatter();
  const [items, setItems] = useState<ImportJob[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const query = new URLSearchParams({ limit: '100', ...(all ? {} : { mine: 'true' }) });
    if (object) query.set('object', object);
    void cellApi<{ items: ImportJob[] }>('GET', `/v1/imports?${query.toString()}`).then((r) => {
      if (r.ok) setItems(r.data.items);
      else setFailed(true);
    });
  }, [object, all]);

  if (failed) return <Banner tone="danger">{t('unavailable')}</Banner>;
  if (!items)
    return (
      <div aria-busy="true" className="flex flex-col gap-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  if (items.length === 0)
    return <EmptyState icon={<History />} title={t('emptyTitle')} description={t('emptyBody')} />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-body-sm">
        <caption className="sr-only">{t('caption')}</caption>
        <thead>
          <tr className="border-b border-line text-caption text-fg-secondary">
            {(['file', 'status', 'created', 'updated', 'failed', 'by', 'when'] as const).map(
              (c) => (
                <th
                  key={c}
                  scope="col"
                  className="whitespace-nowrap py-2 pe-4 text-start font-medium"
                >
                  {t(`columns.${c}`)}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {items.map((job) => {
            const section = sectionForObject(job.object);
            return (
              <tr key={job.id} className="border-b border-line-subtle">
                <td className="max-w-64 truncate py-2 pe-4">
                  {section ? (
                    <Link href={`/${section}/import?job=${job.id}`} className="text-link">
                      {job.fileName}
                    </Link>
                  ) : (
                    job.fileName
                  )}
                </td>
                <td className="py-2 pe-4">
                  <StatusChip tone={STATUS_TONE[job.status]}>
                    {ts(statusKey(job.status))}
                  </StatusChip>
                </td>
                <td className="py-2 pe-4 tabular">{job.created.toLocaleString()}</td>
                <td className="py-2 pe-4 tabular">{job.updated.toLocaleString()}</td>
                <td className="py-2 pe-4 tabular">{job.failed.toLocaleString()}</td>
                <td className="py-2 pe-4">{job.createdBy?.name ?? '—'}</td>
                <td className="whitespace-nowrap py-2 pe-4 text-fg-secondary">
                  {format.dateTime(new Date(job.createdAt), {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
