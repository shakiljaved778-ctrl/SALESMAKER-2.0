'use client';

import type { CurrencyRateDto, RateChangeDto, TenantCurrencyDto } from '@sm/contracts';
import {
  Banner,
  Button,
  Combobox,
  Dialog,
  FormField,
  IconButton,
  Input,
  StatusChip,
  useToast,
} from '@sm/ui';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import type { z } from 'zod';

import { cellApi } from '../../../lib/cell-api';
import { ResourceState, useResource } from '../common';
import { SetupHeader, useHasPermission } from '../setup-shell';
import { useSetupProblem } from '../use-problem';

type Currency = z.infer<typeof TenantCurrencyDto>;
type Rate = z.infer<typeof CurrencyRateDto>;
type RateChange = z.infer<typeof RateChangeDto>;

const RATE = /^\d{1,10}(\.\d{1,8})?$/;
const today = () => new Date().toISOString().slice(0, 10);

/** Dated rates of one currency (ADR-0031): add, change or remove; each change recalculates. */
function RatesPanel({ currency, corporate }: { currency: Currency; corporate: string }) {
  const t = useTranslations('setup.currencies');
  const tc = useTranslations('common.actions');
  const toast = useToast();
  const problem = useSetupProblem();
  const locale = useLocale();
  const canChange = useHasPermission('customize_application');
  const path = `/v1/currencies/${currency.code}/rates`;
  const { data, failure, reload } = useResource<{ items: Rate[] }>(path);
  const [editing, setEditing] = useState<Rate | 'new' | null>(null);
  const [date, setDate] = useState(today());
  const [rate, setRate] = useState('');
  const [error, setError] = useState('');
  const fmtDate = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });

  const done = () => {
    toast({ tone: 'success', title: t('recalculating') });
    setEditing(null);
    reload();
  };
  const save = async () => {
    setError('');
    const r = await cellApi<RateChange>('PUT', `${path}/${date}`, {
      rate,
      ...(editing && editing !== 'new' ? { version: editing.version } : {}),
    });
    if (!r.ok) {
      setError(problem(r));
      return;
    }
    done();
  };
  const remove = async (row: Rate) => {
    const r = await cellApi<RateChange>('DELETE', `${path}/${row.effectiveDate}`);
    if (!r.ok) toast({ tone: 'error', title: problem(r) });
    else done();
  };

  if (!data) return <ResourceState failure={failure} loading />;
  return (
    <section aria-labelledby={`rates-${currency.code}`} className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id={`rates-${currency.code}`} className="text-title-3 text-fg">
          {t('ratesFor', { code: currency.code })}
        </h2>
        {canChange ? (
          <Button
            icon={<Plus />}
            onClick={() => {
              setEditing('new');
              setDate(today());
              setRate('');
              setError('');
            }}
          >
            {t('addRate')}
          </Button>
        ) : null}
      </div>
      <p className="text-body-sm text-fg-secondary">
        {t('rateHelp', { code: currency.code, corporate })}
      </p>
      {data.items.length === 0 ? (
        <p className="text-body-sm text-fg-secondary">{t('noRates')}</p>
      ) : (
        <table className="w-full border-collapse text-body-sm">
          <thead>
            <tr className="border-b border-line text-caption text-fg-secondary">
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('effectiveFrom')}
              </th>
              <th scope="col" className="px-3 py-2 text-end font-medium">
                {t('rate')}
              </th>
              {canChange ? (
                <th scope="col" className="px-3 py-2">
                  <span className="sr-only">{t('actions')}</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {data.items.map((row) => (
              <tr key={row.id} className="border-b border-line-subtle">
                <td className="px-3 py-2 text-fg">
                  {fmtDate.format(new Date(`${row.effectiveDate}T00:00:00Z`))}
                </td>
                <td className="px-3 py-2 text-end font-mono tabular-nums text-fg">{row.rate}</td>
                {canChange ? (
                  <td className="px-3 py-2 text-end">
                    <span className="inline-flex gap-1">
                      <IconButton
                        label={t('editRate', { date: row.effectiveDate })}
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditing(row);
                          setDate(row.effectiveDate);
                          setRate(row.rate);
                          setError('');
                        }}
                      >
                        <Pencil />
                      </IconButton>
                      <IconButton
                        label={t('removeRate', { date: row.effectiveDate })}
                        size="sm"
                        variant="ghost"
                        onClick={() => void remove(row)}
                      >
                        <Trash2 />
                      </IconButton>
                    </span>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Dialog
        open={editing !== null}
        onOpenChange={(o) => {
          if (!o) setEditing(null);
        }}
        size="sm"
        title={editing === 'new' ? t('addRate') : t('changeRate')}
        closeLabel={tc('close')}
        footer={
          <>
            <Button
              onClick={() => {
                setEditing(null);
              }}
            >
              {tc('cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!RATE.test(rate) || !/[1-9]/.test(rate) || !date}
              onClick={() => void save()}
            >
              {tc('save')}
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <FormField label={t('effectiveFrom')} required>
            <Input
              type="date"
              value={date}
              disabled={editing !== 'new'}
              onChange={(e) => {
                setDate(e.target.value);
              }}
            />
          </FormField>
          <FormField
            label={t('rate')}
            required
            helper={t('rateInputHelp', { code: currency.code, corporate })}
            error={rate && !RATE.test(rate) ? t('rateInvalid') : undefined}
          >
            <Input
              inputMode="decimal"
              dir="ltr"
              className="text-end tabular-nums [&_input]:text-end"
              value={rate}
              onChange={(e) => {
                setRate(e.target.value.trim());
              }}
            />
          </FormField>
        </div>
      </Dialog>
    </section>
  );
}

/** Setup → Currencies & rates (Q13, ADR-0031): the corporate currency, others in use, dated rates. */
export function CurrenciesPage() {
  const t = useTranslations('setup.currencies');
  const tc = useTranslations('common.actions');
  const ts = useTranslations('setup.common');
  const toast = useToast();
  const problem = useSetupProblem();
  const locale = useLocale();
  const canChange = useHasPermission('customize_application');
  const { data, failure, reload } = useResource<{ items: Currency[] }>('/v1/currencies');
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const names = useMemo(() => new Intl.DisplayNames([locale], { type: 'currency' }), [locale]);
  const options = useMemo(() => {
    const used = new Set((data?.items ?? []).map((c) => c.code));
    return Intl.supportedValuesOf('currency')
      .filter((c) => !used.has(c))
      .map((c) => ({ value: c, label: `${c} · ${names.of(c) ?? c}` }));
  }, [data, names]);

  if (!data) return <ResourceState failure={failure} loading />;
  const corporate = data.items.find((c) => c.corporate)?.code ?? '';
  const current = data.items.find((c) => c.code === selected && !c.corporate) ?? null;

  const add = async () => {
    setError('');
    const r = await cellApi('POST', '/v1/currencies', { code });
    if (!r.ok) {
      setError(problem(r, { conflict: t('alreadyUsed') }));
      return;
    }
    toast({ tone: 'success', title: ts('created', { name: code }) });
    setAdding(false);
    setSelected(code);
    reload();
  };
  const toggle = async (c: Currency) => {
    const r = await cellApi('PATCH', `/v1/currencies/${c.code}`, { active: !c.active });
    if (r.ok) {
      toast({ tone: 'success', title: ts('saved') });
      reload();
    } else toast({ tone: 'error', title: problem(r) });
  };

  return (
    <>
      <SetupHeader
        title={t('title')}
        description={t('description', { corporate })}
        actions={
          canChange ? (
            <Button
              variant="primary"
              icon={<Plus />}
              onClick={() => {
                setAdding(true);
                setCode('');
                setError('');
              }}
            >
              {t('add')}
            </Button>
          ) : null
        }
      />
      <div className="grid gap-8 p-[var(--page-padding)]">
        <table className="w-full border-collapse text-body-sm">
          <thead>
            <tr className="border-b border-line text-caption text-fg-secondary">
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('currency')}
              </th>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('status')}
              </th>
              <th scope="col" className="px-3 py-2 text-end font-medium">
                {t('currentRate')}
              </th>
              <th scope="col" className="px-3 py-2">
                <span className="sr-only">{t('actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((c) => (
              <tr
                key={c.code}
                data-selected={selected === c.code}
                className="border-b border-line-subtle data-[selected=true]:bg-selected"
              >
                <th scope="row" className="px-3 py-2 text-start font-normal">
                  <span className="font-mono text-fg">{c.code}</span>{' '}
                  <span className="text-fg-secondary">{c.name}</span>
                </th>
                <td className="px-3 py-2">
                  {c.corporate ? (
                    <StatusChip tone="info">{t('corporate')}</StatusChip>
                  ) : (
                    <StatusChip tone={c.active ? 'success' : 'neutral'}>
                      {c.active ? t('active') : t('inactive')}
                    </StatusChip>
                  )}
                </td>
                <td className="px-3 py-2 text-end font-mono tabular-nums text-fg">
                  {c.corporate ? '1' : (c.currentRate?.rate ?? '—')}
                </td>
                <td className="px-3 py-2 text-end">
                  {c.corporate ? null : (
                    <span className="inline-flex gap-2">
                      <Button
                        size="sm"
                        aria-pressed={selected === c.code}
                        onClick={() => {
                          setSelected(selected === c.code ? null : c.code);
                        }}
                      >
                        {t('rates')}
                      </Button>
                      {canChange ? (
                        <Button size="sm" onClick={() => void toggle(c)}>
                          {c.active ? t('deactivate') : t('activate')}
                        </Button>
                      ) : null}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {current ? (
          <RatesPanel key={current.code} currency={current} corporate={corporate} />
        ) : null}
      </div>
      <Dialog
        open={adding}
        onOpenChange={setAdding}
        size="sm"
        title={t('add')}
        closeLabel={tc('close')}
        footer={
          <>
            <Button
              onClick={() => {
                setAdding(false);
              }}
            >
              {tc('cancel')}
            </Button>
            <Button variant="primary" disabled={!code} onClick={() => void add()}>
              {t('add')}
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <FormField label={t('currency')} required>
            <Combobox
              options={options}
              value={code}
              onValueChange={setCode}
              placeholder={t('choose')}
              searchPlaceholder={t('search')}
              emptyText={t('noMatch')}
            />
          </FormField>
        </div>
      </Dialog>
    </>
  );
}
