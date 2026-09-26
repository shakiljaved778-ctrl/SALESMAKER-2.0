'use client';

import { Banner, Button, Dialog, FormField, Input, Skeleton, Textarea, useToast } from '@sm/ui';
import { ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState, type ReactNode, type SyntheticEvent } from 'react';

import type { ApiResult } from '../../lib/client-api';
import { cellApi } from '../../lib/cell-api';
import { useSetupProblem } from './use-problem';

/** Load one Setup resource; `reload` fetches it again, `replace` swaps in a saved copy. */
export function useResource<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [failure, setFailure] = useState<ApiResult<unknown> | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void cellApi<T>('GET', path).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setData(result.data);
        setFailure(null);
      } else setFailure(result);
    });
    return () => {
      cancelled = true;
    };
  }, [path, nonce]);
  const reload = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);
  return { data, failure, reload, replace: setData };
}

/** Loading and error states shared by every Setup page. */
export function ResourceState({
  failure,
  loading,
}: {
  failure: ApiResult<unknown> | null;
  loading: boolean;
}) {
  const problem = useSetupProblem();
  if (failure)
    return (
      <div className="p-[var(--page-padding)]">
        <Banner tone="danger">{problem(failure)}</Banner>
      </div>
    );
  if (loading)
    return (
      <div aria-busy="true" className="flex flex-col gap-3 p-[var(--page-padding)]">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  return null;
}

export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 text-body-sm text-link">
      <ChevronLeft aria-hidden="true" data-mirror="" className="size-4" />
      {children}
    </Link>
  );
}

/** "Delete {name}?" with the page's own wording for a 409 (still in use). */
export function DeleteDialog({
  open,
  onOpenChange,
  name,
  path,
  inUse,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  path: string;
  inUse: string;
  onDeleted: () => void;
}) {
  const t = useTranslations('setup.common');
  const tc = useTranslations('common');
  const toast = useToast();
  const problem = useSetupProblem();
  const [pending, setPending] = useState(false);
  const remove = async () => {
    setPending(true);
    const result = await cellApi('DELETE', path);
    setPending(false);
    onOpenChange(false);
    if (!result.ok) {
      toast({ tone: 'error', title: problem(result, { conflict: inUse }) });
      return;
    }
    toast({ tone: 'success', title: t('deleted', { name }) });
    onDeleted();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={t('deleteTitle', { name })}
      description={t('deleteBody')}
      closeLabel={tc('actions.close')}
      footer={
        <>
          <Button
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {tc('actions.cancel')}
          </Button>
          <Button variant="danger" disabled={pending} onClick={() => void remove()}>
            {t('delete')}
          </Button>
        </>
      }
    >
      {null}
    </Dialog>
  );
}

/**
 * Create a named Setup entity: name and description, plus any extra fields. Returns the created
 * entity to `onCreated`.
 */
export interface Created {
  id: string;
  parentId?: string | null;
}

export function CreateDialog({
  title,
  path,
  extra,
  body,
  onClose,
  onCreated,
}: {
  title: string;
  path: string;
  extra?: ReactNode;
  body?: Record<string, unknown>;
  onClose: () => void;
  onCreated: (created: Created) => void;
}) {
  const t = useTranslations('setup.common');
  const tc = useTranslations('common');
  const ta = useTranslations('auth.errors');
  const toast = useToast();
  const problem = useSetupProblem();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setError(ta('required'));
      return;
    }
    setPending(true);
    const result = await cellApi<Created>('POST', path, {
      name: name.trim(),
      description: description.trim() || null,
      ...body,
    });
    setPending(false);
    if (!result.ok) {
      setError(problem(result, { conflict: t('nameTaken') }));
      return;
    }
    toast({ tone: 'success', title: t('created', { name: name.trim() }) });
    onCreated(result.data);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={title}
      closeLabel={tc('actions.close')}
      dirty={Boolean(name || description)}
      discardCopy={{
        title: t('discardTitle'),
        body: t('discardBody'),
        confirm: t('discard'),
        cancel: t('keepEditing'),
      }}
      footer={
        <>
          <Button onClick={onClose}>{tc('actions.cancel')}</Button>
          <Button variant="primary" type="submit" form="setup-create" disabled={pending}>
            {t('create')}
          </Button>
        </>
      }
    >
      <form
        id="setup-create"
        noValidate
        onSubmit={(e) => void submit(e)}
        className="flex flex-col gap-4"
      >
        <FormField label={t('name')} error={error ?? undefined} required>
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </FormField>
        <FormField label={t('description')}>
          <Textarea
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
            }}
          />
        </FormField>
        {extra}
      </form>
    </Dialog>
  );
}

/** Editable name and description, saved with the page's version. */
export function NameFields({
  name,
  description,
  onChange,
  readOnly,
}: {
  name: string;
  description: string;
  onChange: (next: { name: string; description: string }) => void;
  readOnly?: boolean;
}) {
  const t = useTranslations('setup.common');
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FormField label={t('name')} required disabled={readOnly}>
        <Input
          value={name}
          onChange={(e) => {
            onChange({ name: e.target.value, description });
          }}
        />
      </FormField>
      <FormField label={t('description')} disabled={readOnly}>
        <Input
          value={description}
          onChange={(e) => {
            onChange({ name, description: e.target.value });
          }}
        />
      </FormField>
    </div>
  );
}
