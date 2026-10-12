'use client';

import { Banner, Button, Dialog, StatusChip, useToast } from '@sm/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { cellApi } from '../../lib/cell-api';
import { ProgressBar } from './progress-bar';
import { statusKey, type ImportJob, type ImportRow } from './types';

const POLL_MS = 1500;
const ACTIVE = new Set(['QUEUED', 'RUNNING', 'UNDOING']);
type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
export const STATUS_TONE: Record<ImportJob['status'], Tone> = {
  UPLOADED: 'neutral',
  READY: 'neutral',
  QUEUED: 'info',
  RUNNING: 'info',
  COMPLETED: 'success',
  FAILED: 'danger',
  CANCELLED: 'neutral',
  UNDOING: 'warning',
  UNDONE: 'neutral',
};

/**
 * A started import (§7.1): progress while the worker runs it, then the outcome with the results
 * file, the rows that failed, and undo within 72 hours.
 */
export function ImportProgress({
  job,
  section,
  onChange,
}: {
  job: ImportJob;
  section: string;
  onChange: (job: ImportJob) => void;
}) {
  const t = useTranslations('imports.run');
  const ts = useTranslations('imports.status');
  const tc = useTranslations('common.actions');
  const toast = useToast();
  const [failed, setFailed] = useState<ImportRow[] | null>(null);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ACTIVE.has(job.status)) return;
    const timer = setInterval(() => {
      void cellApi<ImportJob>('GET', `/v1/imports/${job.id}`).then((r) => {
        if (r.ok) onChange(r.data);
      });
    }, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [job.id, job.status, onChange]);

  const download = async () => {
    const r = await cellApi<{ url: string }>('GET', `/v1/imports/${job.id}/results`);
    if (r.ok) window.location.assign(r.data.url);
    else setError(t('resultsUnavailable'));
  };
  const showFailed = async () => {
    const r = await cellApi<{ items: ImportRow[] }>(
      'GET',
      `/v1/imports/${job.id}/rows?status=FAILED&limit=100`,
    );
    if (r.ok) setFailed(r.data.items);
  };
  const undo = async () => {
    setConfirmUndo(false);
    const r = await cellApi<ImportJob>('POST', `/v1/imports/${job.id}/undo`);
    if (r.ok) {
      onChange(r.data);
      toast({ tone: 'info', title: t('undoStarted') });
    } else setError(t('undoRefused'));
  };

  const done = job.processed;
  const total = job.total;
  return (
    <section aria-labelledby="import-outcome" className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="import-outcome" className="text-title-3 text-fg">
          {job.fileName}
        </h2>
        <StatusChip tone={STATUS_TONE[job.status]}>{ts(statusKey(job.status))}</StatusChip>
      </div>
      {error ? (
        <Banner tone="danger" role="alert">
          {error}
        </Banner>
      ) : null}
      {ACTIVE.has(job.status) ? (
        total ? (
          <ProgressBar value={done / total} label={t('progress', { done, total })} />
        ) : (
          <p className="text-body-sm text-fg" aria-live="polite">
            {job.status === 'UNDOING' ? t('undoing') : t('processed', { done })}
          </p>
        )
      ) : null}
      <dl aria-live="polite" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(
          [
            ['created', job.created],
            ['updated', job.updated],
            ['skipped', job.skipped],
            ['failed', job.failed],
          ] as const
        ).map(([k, n]) => (
          <div key={k} className="rounded-md border border-line p-3">
            <dt className="text-caption text-fg-secondary">{t(`counts.${k}`)}</dt>
            <dd className="font-mono text-title-2 text-fg tabular">{n.toLocaleString()}</dd>
          </div>
        ))}
      </dl>
      {job.status === 'FAILED' && job.error ? (
        <Banner tone="danger">{t('jobFailed', { error: job.error })}</Banner>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {job.hasResults ? (
          <Button variant="secondary" onClick={() => void download()}>
            {t('download')}
          </Button>
        ) : null}
        {job.failed > 0 && !ACTIVE.has(job.status) ? (
          <Button variant="secondary" onClick={() => void showFailed()}>
            {t('showFailed')}
          </Button>
        ) : null}
        {job.undoableUntil ? (
          <Button
            variant="secondary"
            onClick={() => {
              setConfirmUndo(true);
            }}
          >
            {t('undo')}
          </Button>
        ) : null}
        <Link href={`/${section}`} className="ms-auto self-center text-body-sm text-link">
          {t('toList')}
        </Link>
      </div>
      {failed ? (
        <table className="w-full border-collapse text-body-sm">
          <caption className="py-2 text-start text-label text-fg">{t('failedRows')}</caption>
          <thead>
            <tr className="border-b border-line text-caption text-fg-secondary">
              <th scope="col" className="py-1.5 text-start font-medium">
                {t('row')}
              </th>
              <th scope="col" className="py-1.5 text-start font-medium">
                {t('reasons')}
              </th>
            </tr>
          </thead>
          <tbody>
            {failed.map((r) => (
              <tr key={r.row} className="border-b border-line-subtle">
                <td className="py-1.5 tabular">{r.row}</td>
                <td className="py-1.5 font-mono text-caption">
                  {r.errors.map((e) => `${e.field}: ${e.code}`).join(', ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      <Dialog
        open={confirmUndo}
        onOpenChange={setConfirmUndo}
        title={t('undoTitle')}
        description={t('undoBody', { n: job.created })}
        closeLabel={tc('close')}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirmUndo(false);
              }}
            >
              {tc('cancel')}
            </Button>
            <Button variant="danger" onClick={() => void undo()}>
              {t('undo')}
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </section>
  );
}
