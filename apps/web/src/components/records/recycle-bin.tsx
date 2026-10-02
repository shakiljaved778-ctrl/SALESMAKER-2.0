'use client';

import type { RecycleBinItemDto } from '@sm/contracts';
import { Banner, Button, EmptyState, Skeleton, useToast } from '@sm/ui';
import { FileText, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import type { z } from 'zod';

import { cellApi } from '../../lib/cell-api';
import { OBJECT_ICONS, sectionForObject } from './fields';
import { readableObjects, type ObjectSummary } from './search-client';

type Item = z.infer<typeof RecycleBinItemDto>;

/**
 * Recycle bin (§7.5): what the caller deleted (everything, for users who may modify all data),
 * restorable until it is purged after 30 days. Children deleted with a parent come back with it.
 */
export function RecycleBin() {
  const t = useTranslations('records.recycleBin');
  const fmt = useFormatter();
  const toast = useToast();
  const [items, setItems] = useState<Item[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [objects, setObjects] = useState<ObjectSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await cellApi<{ items: Item[] }>('GET', '/v1/recycle-bin');
    if (r.ok) setItems(r.data.items);
    else setFailed(true);
  }, []);
  useEffect(() => {
    void load();
    void readableObjects().then(setObjects);
  }, [load]);

  const restore = async (item: Item) => {
    setBusy(item.id);
    const r = await cellApi<{ restored: number }>(
      'POST',
      `/v1/records/${item.object}/${item.recordId}/restore`,
    );
    setBusy(null);
    if (r.ok) {
      const section = sectionForObject(item.object);
      toast({
        tone: 'success',
        title: t('restored', { name: item.name, count: r.data.restored }),
        ...(section
          ? {
              action: {
                label: t('view'),
                onClick: () => {
                  window.location.assign(`/${section}/${item.recordId}`);
                },
              },
            }
          : {}),
      });
      void load();
    } else
      toast({
        tone: 'error',
        title: r.status === 409 ? t('restoreParent') : t('restoreFailed'),
      });
  };

  const labelOf = (o: string) => objects.find((x) => x.name === o)?.label ?? o;
  return (
    <div className="grid max-w-5xl gap-4 p-[var(--page-padding)]">
      <div>
        <h1 className="text-title-1 text-fg">{t('title')}</h1>
        <p className="text-body-sm text-fg-secondary">{t('description')}</p>
      </div>
      {failed ? (
        <Banner tone="danger">{t('loadFailed')}</Banner>
      ) : items === null ? (
        <Skeleton className="h-48 w-full" />
      ) : items.length === 0 ? (
        <EmptyState icon={<Trash2 />} title={t('emptyTitle')} description={t('emptyBody')} />
      ) : (
        <table className="w-full border-collapse rounded-md bg-surface text-body-sm shadow-e1">
          <thead>
            <tr className="border-b border-line text-caption text-fg-secondary">
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('name')}
              </th>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('object')}
              </th>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('deleted')}
              </th>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('purge')}
              </th>
              <th scope="col" className="px-3 py-2">
                <span className="sr-only">{t('actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const Icon = OBJECT_ICONS[item.object] ?? FileText;
              return (
                <tr key={item.id} className="border-b border-line-subtle">
                  <th scope="row" className="px-3 py-2 text-start font-medium text-fg">
                    <span className="inline-flex items-center gap-2">
                      <Icon aria-hidden className="size-4 text-fg-secondary" />
                      {item.name}
                    </span>
                  </th>
                  <td className="px-3 py-2 text-fg-secondary">{labelOf(item.object)}</td>
                  <td className="px-3 py-2 text-fg-secondary">
                    <time dateTime={item.deletedAt}>
                      {fmt.dateTime(new Date(item.deletedAt), {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </time>
                  </td>
                  <td className="px-3 py-2 text-fg-secondary">
                    <time dateTime={item.purgeAfter}>
                      {fmt.dateTime(new Date(item.purgeAfter), { dateStyle: 'medium' })}
                    </time>
                  </td>
                  <td className="px-3 py-2 text-end">
                    <Button size="sm" loading={busy === item.id} onClick={() => void restore(item)}>
                      {t('restore')}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="text-caption text-fg-secondary">
        <Link href="/home" className="text-link underline-offset-4 hover:underline">
          {t('back')}
        </Link>
      </p>
    </div>
  );
}
