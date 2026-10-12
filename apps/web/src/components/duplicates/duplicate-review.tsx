'use client';

import type { DuplicateCandidateDto } from '@sm/contracts';
import { Banner, Button, EmptyState, Skeleton, useToast } from '@sm/ui';
import { CopyCheck } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import type { z } from 'zod';

import { cellApi } from '../../lib/cell-api';
import { cellValue, recordName, type DescribedObject, type RecordRow } from '../records/fields';
import { MergeDialog, plainText } from './merge-dialog';

type Candidate = z.infer<typeof DuplicateCandidateDto>;
/** Fields compared in the detail pane, when the object has them. */
const COMPARED = [
  'email',
  'phone',
  'mobile_phone',
  'company',
  'title',
  'website',
  'city',
  'country',
];

/**
 * Duplicate review (§7.2, template T7): groups found by duplicate jobs on the start side, the
 * selected group's records compared on the end side, with Merge and Not duplicates.
 */
export function DuplicateReview({ object, section }: { object: string; section: string }) {
  const t = useTranslations('duplicates.review');
  const toast = useToast();
  const [describe, setDescribe] = useState<DescribedObject | null>(null);
  const [items, setItems] = useState<Candidate[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [rows, setRows] = useState<RecordRow[] | null>(null);
  const [merging, setMerging] = useState(false);

  const loadList = useCallback(async () => {
    const r = await cellApi<{ items: Candidate[] }>(
      'GET',
      `/v1/duplicate-candidates?object=${object}&status=OPEN&limit=100`,
    );
    if (!r.ok) {
      setFailed(true);
      return;
    }
    setItems(r.data.items);
    setSelected((s) =>
      s && r.data.items.some((c) => c.id === s) ? s : (r.data.items[0]?.id ?? null),
    );
  }, [object]);

  useEffect(() => {
    void cellApi<DescribedObject>('GET', `/v1/objects/${object}/describe`).then((r) => {
      if (r.ok) setDescribe(r.data);
    });
    void loadList();
  }, [object, loadList]);

  const group = items?.find((c) => c.id === selected) ?? null;
  const groupKey = group?.records.map((r) => r.id).join(',') ?? '';
  useEffect(() => {
    setRows(null);
    if (!groupKey) return;
    void Promise.all(
      groupKey.split(',').map((id) => cellApi<RecordRow>('GET', `/v1/records/${object}/${id}`)),
    ).then((results) => {
      setRows(results.flatMap((r) => (r.ok ? [r.data] : [])));
    });
  }, [object, groupKey]);

  const dismiss = async () => {
    if (!group) return;
    const r = await cellApi('POST', `/v1/duplicate-candidates/${group.id}/dismiss`);
    if (r.ok) toast({ tone: 'success', title: t('dismissed') });
    void loadList();
  };

  if (failed)
    return (
      <div className="p-[var(--page-padding)]">
        <Banner tone="danger">{t('unavailable')}</Banner>
      </div>
    );
  if (!items || !describe)
    return (
      <div aria-busy="true" className="grid gap-3 p-[var(--page-padding)]">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    );

  const compared = describe.fields.filter((f) => COMPARED.includes(f.name));
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-[var(--page-padding)]">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-title-1 text-fg">{t('title', { objects: describe.labelPlural })}</h1>
          <p className="text-caption text-fg-secondary">{t('count', { n: items.length })}</p>
        </div>
        <Link href={`/${section}`} className="text-body-sm text-link">
          {t('backTo', { objects: describe.labelPlural })}
        </Link>
      </header>
      {items.length === 0 ? (
        <EmptyState icon={<CopyCheck />} title={t('emptyTitle')} description={t('emptyBody')} />
      ) : (
        <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[360px_minmax(0,1fr)]">
          <nav
            aria-label={t('groups')}
            className="min-h-0 overflow-y-auto rounded-md border border-line bg-surface"
          >
            <ul>
              {items.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    aria-current={c.id === selected ? 'true' : undefined}
                    onClick={() => {
                      setSelected(c.id);
                    }}
                    className={`flex w-full flex-col gap-0.5 border-b border-line-subtle px-3 py-2.5 text-start hover:bg-hover ${
                      c.id === selected ? 'bg-selected' : ''
                    }`}
                  >
                    <span className="truncate text-body-sm font-medium text-fg">
                      {c.records.map((r) => r.name ?? t('unnamed')).join(' · ')}
                    </span>
                    <span className="text-caption text-fg-secondary">
                      {t('score', { score: Math.round(c.score * 100), n: c.records.length })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <section
            aria-labelledby="group-title"
            className="flex min-h-0 flex-col gap-4 overflow-y-auto rounded-md border border-line bg-surface p-4"
          >
            {group ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 id="group-title" className="text-title-3 text-fg">
                    {t('groupTitle', { n: group.records.length })}
                  </h2>
                  <div className="flex gap-2">
                    <Button variant="secondary" onClick={() => void dismiss()}>
                      {t('dismiss')}
                    </Button>
                    <Button
                      variant="primary"
                      disabled={!describe.access.edit || !describe.access.delete}
                      onClick={() => {
                        setMerging(true);
                      }}
                    >
                      {t('merge')}
                    </Button>
                  </div>
                </div>
                {!rows ? (
                  <Skeleton className="h-40 w-full" />
                ) : (
                  <table className="w-full border-collapse text-body-sm">
                    <caption className="sr-only">{t('caption')}</caption>
                    <thead>
                      <tr className="border-b border-line">
                        <th
                          scope="col"
                          className="w-40 py-2 pe-3 text-start text-caption font-medium text-fg-secondary"
                        >
                          {t('field')}
                        </th>
                        {rows.map((r) => (
                          <th key={r.id} scope="col" className="py-2 pe-3 text-start font-medium">
                            <Link href={`/${section}/${r.id}`} className="text-link">
                              {recordName(describe, r)}
                            </Link>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {compared.map((f) => (
                        <tr key={f.name} className="border-b border-line-subtle">
                          <th
                            scope="row"
                            className="py-2 pe-3 text-start font-normal text-fg-secondary"
                          >
                            {f.label}
                          </th>
                          {rows.map((r) => {
                            const { value } = cellValue(r[f.name]);
                            return (
                              <td key={r.id} className="truncate py-2 pe-3 text-fg">
                                {plainText(value)}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            ) : null}
          </section>
        </div>
      )}
      {merging && group ? (
        <MergeDialog
          object={object}
          describe={describe}
          ids={group.records.map((r) => r.id)}
          open={merging}
          onOpenChange={setMerging}
          onMerged={() => {
            void loadList();
          }}
        />
      ) : null}
    </div>
  );
}
