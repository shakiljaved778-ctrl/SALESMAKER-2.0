'use client';

import type { ConvertLeadResult, SearchResultDto } from '@sm/contracts';
import {
  Banner,
  Button,
  Checkbox,
  Dialog,
  FormField,
  Input,
  Radio,
  RadioGroup,
  Select,
  useToast,
} from '@sm/ui';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import type { z } from 'zod';

import { cellApi } from '../../lib/cell-api';
import type { DescribedObject, RecordRow } from './fields';

type Result = z.infer<typeof ConvertLeadResult>;
interface Match {
  id: string;
  name: string;
}

const MATCHES = 5;
/** A new opportunity's close date starts this far out; the rep can change it here. */
const DEFAULT_CLOSE_DAYS = 30;
const NEW = '__new__';

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Lead conversion (§7.3): match an existing account (by company) and contact (by email), or create
 * them; optionally create an opportunity; pick the converted status. Undo is offered for 24 hours.
 */
export function ConvertDialog({
  lead,
  describe,
  open,
  onOpenChange,
}: {
  lead: RecordRow;
  describe: DescribedObject;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('records.convert');
  const tc = useTranslations('common.actions');
  const toast = useToast();
  const router = useRouter();
  const company = text(lead['company']);
  const person = [text(lead['first_name']), text(lead['last_name'])].filter(Boolean).join(' ');
  const email = text(lead['email']);
  const [accounts, setAccounts] = useState<Match[]>([]);
  const [contacts, setContacts] = useState<Match[]>([]);
  const [account, setAccount] = useState(NEW);
  const [accountName, setAccountName] = useState(company);
  const [contact, setContact] = useState(NEW);
  const [withOpportunity, setWithOpportunity] = useState(true);
  const [opportunityName, setOpportunityName] = useState(company ? `${company} -` : '');
  const [closeDate, setCloseDate] = useState(() => {
    const d = new Date(Date.now() + DEFAULT_CLOSE_DAYS * 86_400_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  });
  const statuses = (describe.fields.find((f) => f.name === 'status')?.picklistValues ?? []).filter(
    (v) => v.category === 'converted',
  );
  const [status, setStatus] = useState(statuses[0]?.value ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Existing accounts whose name matches the lead's company.
  useEffect(() => {
    if (!open || !company) return;
    const q = new URLSearchParams({ q: company, objects: 'account', limit: String(MATCHES) });
    void cellApi<z.infer<typeof SearchResultDto>>('GET', `/v1/search?${q.toString()}`).then((r) => {
      if (!r.ok) return;
      const found = r.data.groups.flatMap((g) =>
        g.hits.map((h) => ({ id: h.id, name: h.name ?? h.id })),
      );
      setAccounts(found);
      // An account named exactly like the lead's company is almost always the one: start there.
      const same = found.find(
        (a) => a.name.localeCompare(company, undefined, { sensitivity: 'base' }) === 0,
      );
      if (same) setAccount(same.id);
    });
  }, [open, company]);

  // Existing contacts with the lead's email, at the chosen account when there is one.
  useEffect(() => {
    if (!open || !email) return;
    const byEmail = { field: 'email', op: 'eq', value: email };
    void cellApi<{ items: RecordRow[] }>('POST', '/v1/query', {
      object: 'contact',
      fields: ['first_name', 'last_name', 'account_id'],
      where:
        account === NEW
          ? byEmail
          : { and: [byEmail, { field: 'account_id', op: 'eq', value: account }] },
      limit: MATCHES,
    }).then((r) => {
      if (!r.ok) return;
      setContacts(
        r.data.items.map((c) => ({
          id: c.id,
          name: [text(c['first_name']), text(c['last_name'])].filter(Boolean).join(' '),
        })),
      );
      setContact(NEW);
    });
  }, [open, email, account]);

  const convert = async () => {
    setBusy(true);
    setError('');
    const r = await cellApi<Result>('POST', `/v1/leads/${lead.id}/convert`, {
      account: account === NEW ? { fields: { name: accountName } } : { id: account },
      contact: contact === NEW ? {} : { id: contact },
      opportunity: withOpportunity
        ? { fields: { name: opportunityName, close_date: closeDate } }
        : null,
      ...(status ? { convertedStatus: status } : {}),
    });
    setBusy(false);
    if (!r.ok) {
      const first = r.problem?.errors?.[0];
      setError(
        first?.code === 'required'
          ? t('required', { field: first.field.replaceAll('_', ' ') })
          : first?.code === 'validation_rule'
            ? first.message
            : t('failed'),
      );
      return;
    }
    onOpenChange(false);
    toast({
      tone: 'success',
      title: t('converted', { name: person }),
      durationMs: 8000,
      action: {
        label: t('undo'),
        onClick: () => {
          void cellApi('POST', `/v1/leads/${lead.id}/convert/undo`).then((u) => {
            if (u.ok) router.push(`/leads/${lead.id}`);
            else toast({ tone: 'error', title: t('undoFailed') });
          });
        },
      },
    });
    router.push(
      r.data.opportunityId
        ? `/opportunities/${r.data.opportunityId}`
        : `/accounts/${r.data.accountId}`,
    );
  };

  const choice = (value: string, label: string) => (
    <Radio key={value} value={value} label={label} />
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={t('title', { name: person })}
      closeLabel={tc('close')}
      footer={
        <>
          <Button
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {tc('cancel')}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={
              (account === NEW && !accountName.trim()) ||
              (withOpportunity && !opportunityName.trim())
            }
            onClick={() => void convert()}
          >
            {t('convert')}
          </Button>
        </>
      }
    >
      <div className="grid gap-5">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-title-3 text-fg">{t('account')}</legend>
          <RadioGroup value={account} onValueChange={setAccount}>
            {choice(NEW, t('newAccount'))}
            {accounts.map((a) => choice(a.id, t('existing', { name: a.name })))}
          </RadioGroup>
          {account === NEW ? (
            <FormField label={t('accountName')} required>
              <Input
                value={accountName}
                onChange={(e) => {
                  setAccountName(e.target.value);
                }}
              />
            </FormField>
          ) : null}
        </fieldset>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-title-3 text-fg">{t('contact')}</legend>
          <RadioGroup value={contact} onValueChange={setContact}>
            {choice(NEW, t('newContact', { name: person }))}
            {contacts.map((c) => choice(c.id, t('existing', { name: c.name })))}
          </RadioGroup>
        </fieldset>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-title-3 text-fg">{t('opportunity')}</legend>
          <Checkbox
            label={t('createOpportunity')}
            checked={withOpportunity}
            onCheckedChange={(c) => {
              setWithOpportunity(c === true);
            }}
          />
          {withOpportunity ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label={t('opportunityName')} required>
                <Input
                  value={opportunityName}
                  onChange={(e) => {
                    setOpportunityName(e.target.value);
                  }}
                />
              </FormField>
              <FormField label={t('closeDate')} required>
                <Input
                  type="date"
                  value={closeDate}
                  onChange={(e) => {
                    setCloseDate(e.target.value);
                  }}
                />
              </FormField>
            </div>
          ) : null}
        </fieldset>
        {statuses.length > 1 ? (
          <FormField label={t('status')}>
            <Select
              options={statuses.map((s) => ({ value: s.value, label: s.label }))}
              value={status}
              onValueChange={setStatus}
            />
          </FormField>
        ) : null}
      </div>
    </Dialog>
  );
}
