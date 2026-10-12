'use client';

import { Banner, Button, Dialog, Radio, RadioGroup, Skeleton, useToast } from '@sm/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';

import { cellApi } from '../../lib/cell-api';
import type { ApiResult } from '../../lib/client-api';
import {
  cellValue,
  picklistOptions,
  recordName,
  type DescribedField,
  type DescribedObject,
  type RecordRow,
} from '../records/fields';
import { useSetupProblem } from '../setup/use-problem';

const empty = (v: unknown) => v === null || v === undefined || v === '';

/** A stored value as plain text. */
export function plainText(value: unknown): string {
  if (empty(value)) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(plainText).join(', ');
  return JSON.stringify(value);
}

/** A value as plain text for comparing records side by side. */
function show(field: DescribedField, raw: unknown, yes: string, no: string): string {
  const { value, currencyCode } = cellValue(raw);
  if (typeof value === 'boolean') return value ? yes : no;
  if (field.type === 'picklist' && typeof value === 'string')
    return picklistOptions(field).find((o) => o.value === value)?.label ?? value;
  const text = plainText(value);
  return currencyCode && text !== '—' ? `${text} ${currencyCode}` : text;
}

/**
 * Merge two or three records (§7.2, modal): choose the record that survives, then, for each field
 * where they differ, whose value it keeps. The others go to the recycle bin with their children
 * moved to the survivor.
 */
export function MergeDialog({
  object,
  describe,
  ids,
  open,
  onOpenChange,
  onMerged,
}: {
  object: string;
  describe: DescribedObject;
  ids: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMerged: (survivorId: string) => void;
}) {
  const t = useTranslations('duplicates.merge');
  const tc = useTranslations('common.actions');
  const problem = useSetupProblem();
  const toast = useToast();
  const [rows, setRows] = useState<RecordRow[] | null>(null);
  const [master, setMaster] = useState<string>(ids[0] ?? '');
  const [winners, setWinners] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loadFailure, setLoadFailure] = useState<ApiResult<unknown> | null>(null);
  const [saving, setSaving] = useState(false);
  const key = ids.join(',');

  useEffect(() => {
    if (!open) return;
    setRows(null);
    setError(null);
    setLoadFailure(null);
    setWinners({});
    setMaster(key.split(',')[0] ?? '');
    void Promise.all(
      key.split(',').map((id) => cellApi<RecordRow>('GET', `/v1/records/${object}/${id}`)),
    ).then((results) => {
      const failed = results.find((r) => !r.ok);
      if (failed) {
        setLoadFailure(failed);
        return;
      }
      setRows(results.flatMap((r) => (r.ok ? [r.data] : [])));
    });
  }, [open, key, object]);

  /** Editable fields whose values differ between the records. */
  const differing = useMemo(
    () =>
      rows
        ? describe.fields.filter((f) => {
            if (!f.editable) return false;
            const values = rows.map((r) => JSON.stringify(r[f.name] ?? null));
            return new Set(values).size > 1;
          })
        : [],
    [rows, describe],
  );
  /** The winner of a field: chosen, else the survivor's value, else the first record with one. */
  const winnerOf = (field: string): string => {
    const chosen = winners[field];
    if (chosen) return chosen;
    const masterRow = rows?.find((r) => r.id === master);
    if (masterRow && !empty(cellValue(masterRow[field]).value)) return master;
    return rows?.find((r) => !empty(cellValue(r[field]).value))?.id ?? master;
  };

  const merge = async () => {
    if (!rows) return;
    setSaving(true);
    setError(null);
    const masterRow = rows.find((r) => r.id === master);
    const fields: Record<string, string> = Object.fromEntries(
      differing.flatMap((f): [string, string][] => {
        const winner = winnerOf(f.name);
        return winner === master ? [] : [[f.name, winner]];
      }),
    );
    const r = await cellApi<{ id: string }>('POST', `/v1/records/${object}/merge`, {
      masterId: master,
      duplicateIds: rows.filter((x) => x.id !== master).map((x) => x.id),
      ...(Object.keys(fields).length ? { fields } : {}),
      ...(masterRow ? { version: masterRow.version } : {}),
    });
    setSaving(false);
    if (!r.ok) {
      setError(problem(r, { conflict: t('conflict'), version_conflict: t('conflict') }));
      return;
    }
    toast({ tone: 'success', title: t('merged', { n: rows.length }) });
    onOpenChange(false);
    onMerged(r.data.id);
  };

  return (
    <Dialog
      size="lg"
      open={open}
      onOpenChange={onOpenChange}
      title={t('title', { n: ids.length, objects: describe.labelPlural })}
      description={t('description')}
      closeLabel={tc('close')}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {tc('cancel')}
          </Button>
          <Button
            variant="primary"
            loading={saving}
            loadingLabel={t('merge')}
            disabled={!rows}
            onClick={() => void merge()}
          >
            {t('merge')}
          </Button>
        </>
      }
    >
      {error || loadFailure ? (
        <Banner tone="danger" role="alert" className="mb-3">
          {error ?? (loadFailure ? problem(loadFailure) : null)}
        </Banner>
      ) : null}
      {!rows ? (
        loadFailure ? null : (
          <div aria-busy="true" className="flex flex-col gap-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        )
      ) : (
        <div className="overflow-x-auto">
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
                  <th key={r.id} scope="col" className="py-2 pe-3 text-start font-medium text-fg">
                    {recordName(describe, r)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-line bg-subtle">
                <th scope="row" className="py-2 pe-3 text-start font-medium text-fg">
                  {t('survivor')}
                </th>
                <td colSpan={rows.length} className="py-2">
                  <RadioGroup
                    aria-label={t('survivor')}
                    value={master}
                    onValueChange={setMaster}
                    className="grid gap-3"
                    style={{
                      gridTemplateColumns: `repeat(${String(rows.length)}, minmax(0, 1fr))`,
                    }}
                  >
                    {rows.map((r) => (
                      <Radio
                        key={r.id}
                        value={r.id}
                        label={t('keep', { name: recordName(describe, r) })}
                      />
                    ))}
                  </RadioGroup>
                </td>
              </tr>
              {differing.length === 0 ? (
                <tr>
                  <td colSpan={rows.length + 1} className="py-3 text-fg-secondary">
                    {t('identical')}
                  </td>
                </tr>
              ) : (
                differing.map((f) => (
                  <tr key={f.name} className="border-b border-line-subtle">
                    <th scope="row" className="py-2 pe-3 text-start font-normal text-fg-secondary">
                      {f.label}
                    </th>
                    <td colSpan={rows.length} className="py-2">
                      <RadioGroup
                        aria-label={f.label}
                        value={winnerOf(f.name)}
                        onValueChange={(id) => {
                          setWinners((w) => ({ ...w, [f.name]: id }));
                        }}
                        className="grid gap-3"
                        style={{
                          gridTemplateColumns: `repeat(${String(rows.length)}, minmax(0, 1fr))`,
                        }}
                      >
                        {rows.map((r) => (
                          <Radio
                            key={r.id}
                            value={r.id}
                            label={show(f, r[f.name], t('yes'), t('no'))}
                          />
                        ))}
                      </RadioGroup>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}
