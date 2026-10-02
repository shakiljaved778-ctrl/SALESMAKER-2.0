'use client';

import type { JobDto, ListViewDto } from '@sm/contracts';
import {
  Banner,
  Button,
  Checkbox,
  Dialog,
  FieldEditor,
  FormField,
  Input,
  Popover,
  RadioGroup,
  Radio,
  Select,
  useToast,
  type FieldEditorValue,
} from '@sm/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { z } from 'zod';

import { cellApi } from '../../lib/cell-api';
import { picklistOptions, uiType, writeValue, type DescribedField } from './fields';
import { useRecordLabels } from './use-record-labels';

type View = z.infer<typeof ListViewDto>;
type Job = z.infer<typeof JobDto>;
export type MassKind = 'update' | 'delete';

/** A list view holds at most this many columns (CreateListViewRequest). */
export const MAX_COLUMNS = 30;
const JOB_POLL_MS = 1000;

/** Column chooser (§9.11 T1): pick and order nothing fancy — toggle fields on and off. */
export function ColumnChooser({
  fields,
  selected,
  required,
  onApply,
  trigger,
}: {
  fields: DescribedField[];
  selected: string[];
  required: string;
  onApply: (columns: string[]) => void;
  trigger: ReactNode;
}) {
  const t = useTranslations('records.list');
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>(selected);
  useEffect(() => {
    if (open) setDraft(selected);
  }, [open, selected]);
  const sorted = useMemo(
    () => [...fields].sort((a, b) => a.label.localeCompare(b.label)),
    [fields],
  );
  return (
    <Popover trigger={trigger} label={t('columns')} open={open} onOpenChange={setOpen} align="end">
      <div className="grid w-64 gap-3">
        <p className="text-caption text-fg-secondary">{t('columnsHelp', { max: MAX_COLUMNS })}</p>
        <div role="group" aria-label={t('columns')} className="grid max-h-80 gap-1.5 overflow-auto">
          {sorted.map((f) => {
            const on = f.name === required || draft.includes(f.name);
            return (
              <Checkbox
                key={f.name}
                label={f.label}
                checked={on}
                disabled={f.name === required || (!on && draft.length >= MAX_COLUMNS)}
                onCheckedChange={(c) => {
                  setDraft((d) => (c === true ? [...d, f.name] : d.filter((x) => x !== f.name)));
                }}
              />
            );
          })}
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            onApply(draft.length ? draft : [required]);
            setOpen(false);
          }}
        >
          {t('apply')}
        </Button>
      </div>
    </Popover>
  );
}

/** "Save as new view": name and, with customize_application, who else sees it. */
export function SaveViewDialog({
  object,
  canShare,
  draft,
  onClose,
}: {
  object: string;
  canShare: boolean;
  draft: Pick<View, 'filter' | 'columns' | 'sort'>;
  onClose: (saved: View | null) => void;
}) {
  const t = useTranslations('records.views');
  const tc = useTranslations('common.actions');
  const td = useTranslations('setup.common');
  const toast = useToast();
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<View['visibility']>('PRIVATE');
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visibility !== 'GROUPS' || groups.length) return;
    void cellApi<{ items: { id: string; name: string }[] }>('GET', '/v1/groups').then((r) => {
      if (r.ok) setGroups(r.data.items);
    });
  }, [visibility, groups.length]);

  const save = async () => {
    setSaving(true);
    const result = await cellApi<View>('POST', `/v1/objects/${object}/list-views`, {
      name,
      visibility,
      groupIds: visibility === 'GROUPS' ? groupIds : [],
      filter: draft.filter,
      columns: draft.columns,
      sort: draft.sort,
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.status === 403 ? t('sharedNeedsPermission') : td('invalid'));
      return;
    }
    toast({ tone: 'success', title: t('saved') });
    onClose(result.data);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose(null);
      }}
      title={t('saveAsTitle')}
      closeLabel={tc('close')}
      dirty={name !== ''}
      discardCopy={{
        title: td('discardTitle'),
        body: td('discardBody'),
        confirm: td('discard'),
        cancel: td('keepEditing'),
      }}
      footer={
        <>
          <Button
            onClick={() => {
              onClose(null);
            }}
          >
            {tc('cancel')}
          </Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={name.trim() === '' || (visibility === 'GROUPS' && groupIds.length === 0)}
            onClick={() => void save()}
          >
            {tc('save')}
          </Button>
        </>
      }
    >
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void save();
        }}
      >
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <FormField label={t('name')} required>
          <Input
            value={name}
            maxLength={80}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </FormField>
        {canShare ? (
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-label text-fg-secondary">{t('visibility')}</legend>
            <RadioGroup
              value={visibility}
              onValueChange={(v) => {
                setVisibility(v as View['visibility']);
              }}
            >
              <Radio value="PRIVATE" label={t('private')} />
              <Radio value="GROUPS" label={t('groups')} />
              <Radio value="ALL" label={t('all')} />
            </RadioGroup>
          </fieldset>
        ) : null}
        {visibility === 'GROUPS' ? (
          <div role="group" aria-label={t('groupList')} className="grid gap-1.5">
            <p className="text-caption text-fg-secondary">{t('groupsHelp')}</p>
            {groups.map((g) => (
              <Checkbox
                key={g.id}
                label={g.name}
                checked={groupIds.includes(g.id)}
                onCheckedChange={(c) => {
                  setGroupIds((ids) =>
                    c === true ? [...ids, g.id] : ids.filter((x) => x !== g.id),
                  );
                }}
              />
            ))}
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}

/** Mass update or delete (§7.5): preview the count, start the job, follow it to the end. */
export function MassActionDialog({
  kind,
  object,
  target,
  count,
  fields,
  onClose,
}: {
  kind: MassKind;
  object: string;
  target: { ids?: string[]; where?: unknown };
  count: number;
  fields: DescribedField[];
  onClose: (changed: boolean) => void;
}) {
  const t = useTranslations('records.mass');
  const tc = useTranslations('common.actions');
  const labels = useRecordLabels();
  const toast = useToast();
  const [fieldName, setFieldName] = useState(fields[0]?.name ?? '');
  const [value, setValue] = useState<FieldEditorValue>(null);
  const [preview, setPreview] = useState<{ count: number; tooMany: boolean } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const field = fields.find((f) => f.name === fieldName);

  const action = useMemo(
    () =>
      kind === 'delete'
        ? { kind: 'delete' as const }
        : { kind: 'update' as const, fields: { [fieldName]: writeValue(value) } },
    [kind, fieldName, value],
  );

  useEffect(() => {
    let cancelled = false;
    void cellApi<{ count: number; tooMany: boolean }>(
      'POST',
      `/v1/records/${object}/mass/preview`,
      { ...target, action },
    ).then((r) => {
      if (!cancelled && r.ok) setPreview(r.data);
    });
    return () => {
      cancelled = true;
    };
  }, [object, action, target]);

  const follow = async (job: Job): Promise<Job> => {
    let current = job;
    while (current.status === 'QUEUED' || current.status === 'RUNNING') {
      await new Promise((resolve) => setTimeout(resolve, JOB_POLL_MS));
      const r = await cellApi<Job>('GET', `/v1/jobs/${current.id}`);
      if (!r.ok) break;
      current = r.data;
    }
    return current;
  };

  const start = async () => {
    setRunning(true);
    setError('');
    const r = await cellApi<Job>('POST', `/v1/records/${object}/mass`, { ...target, action });
    if (!r.ok) {
      setRunning(false);
      setError(r.problem?.detail ?? t('failed'));
      return;
    }
    toast({ tone: 'info', title: t('started', { count: preview?.count ?? count }) });
    const job = await follow(r.data);
    setRunning(false);
    if (job.status === 'SUCCEEDED')
      toast({
        tone: job.failed ? 'error' : 'success',
        title: job.failed
          ? t('doneWithFailures', { done: job.done - job.failed, failed: job.failed })
          : t('done', { done: job.done }),
      });
    else toast({ tone: 'error', title: t('failed') });
    onClose(true);
  };

  const n = preview?.count ?? count;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !running) onClose(false);
      }}
      title={kind === 'delete' ? t('deleteTitle', { count: n }) : t('update')}
      closeLabel={tc('close')}
      footer={
        <>
          <Button
            disabled={running}
            onClick={() => {
              onClose(false);
            }}
          >
            {tc('cancel')}
          </Button>
          <Button
            variant={kind === 'delete' ? 'danger' : 'primary'}
            loading={running}
            disabled={preview?.tooMany === true || (kind === 'update' && !field)}
            onClick={() => void start()}
          >
            {kind === 'delete' ? t('runDelete') : t('run')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {kind === 'update' ? (
          <>
            <FormField label={t('field')}>
              <Select
                options={fields.map((f) => ({ value: f.name, label: f.label }))}
                value={fieldName}
                onValueChange={(v) => {
                  setFieldName(v);
                  setValue(null);
                }}
              />
            </FormField>
            {field ? (
              <FormField label={t('value')}>
                <FieldEditor
                  type={uiType(field.type)}
                  value={value}
                  onChange={setValue}
                  labels={labels.editor}
                  options={picklistOptions(field)}
                />
              </FormField>
            ) : null}
          </>
        ) : (
          <p className="text-body text-fg">{t('deleteBody')}</p>
        )}
        <p className="text-body-sm text-fg-secondary" aria-live="polite">
          {preview?.tooMany ? t('tooMany') : t('preview', { count: n })}
        </p>
      </div>
    </Dialog>
  );
}
