'use client';

import {
  Banner,
  Button,
  Checkbox,
  FormField,
  IconButton,
  Input,
  StatusChip,
  Textarea,
  useToast,
} from '@sm/ui';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { cellApi } from '../../../lib/cell-api';
import type { DescribedObject } from '../../records/fields';
import { BackLink, DeleteDialog, ResourceState, useResource } from '../common';
import { SetupHeader, useHasPermission } from '../setup-shell';
import { useSetupProblem } from '../use-problem';
import type { FieldSetting } from './objects-pages';
import { HAS_VALUES, TYPE_LABEL, fieldLabel, toApiName } from './types';

interface ValueRow {
  apiValue: string;
  label: string;
  active: boolean;
  isDefault: boolean;
  category: string | null;
  /** Saved values keep their API value (records hold it); new ones derive it from the label. */
  saved: boolean;
}

/** Picklist values (§5.2): ordered, relabelled, defaulted and deactivated — never removed. */
function PicklistEditor({
  object,
  field,
  onSaved,
}: {
  object: string;
  field: FieldSetting;
  onSaved: () => void;
}) {
  const t = useTranslations('setup.objects');
  const ts = useTranslations('setup.common');
  const toast = useToast();
  const problem = useSetupProblem();
  const canChange = useHasPermission('customize_application');
  const [rows, setRows] = useState<ValueRow[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setRows(
      [...field.picklistValues]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((v) => ({
          apiValue: v.apiValue,
          label: v.label ?? v.apiValue,
          active: v.active,
          isDefault: v.isDefault,
          category: v.category,
          saved: true,
        })),
    );
  }, [field]);

  const update = (i: number, change: Partial<ValueRow>) => {
    setRows((prev) =>
      prev.map((r, j) => {
        if (change.isDefault && j !== i && field.type === 'picklist')
          return { ...r, isDefault: false };
        return j === i ? { ...r, ...change } : r;
      }),
    );
  };
  const move = (i: number, by: -1 | 1) => {
    setRows((prev) => {
      const next = [...prev];
      const [row] = next.splice(i, 1);
      if (row) next.splice(i + by, 0, row);
      return next;
    });
  };
  const save = async () => {
    setSaving(true);
    setError('');
    const r = await cellApi(
      'PUT',
      `/v1/setup/objects/${object}/fields/${field.apiName}/picklist-values`,
      {
        version: field.version,
        values: rows.map((v) => ({
          apiValue: v.saved ? v.apiValue : toApiName(v.label, 80) || v.apiValue,
          label: v.label.trim() || null,
          active: v.active,
          isDefault: v.isDefault,
          ...(v.category ? { category: v.category } : {}),
        })),
      },
    );
    setSaving(false);
    if (!r.ok) {
      setError(problem(r));
      return;
    }
    toast({ tone: 'success', title: ts('saved') });
    onSaved();
  };

  return (
    <section aria-labelledby="picklist-values" className="grid gap-3">
      <h2 id="picklist-values" className="text-title-3 text-fg">
        {t('values')}
      </h2>
      <p className="text-body-sm text-fg-secondary">{t('valuesHelp')}</p>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <table className="w-full border-collapse text-body-sm">
        <thead>
          <tr className="border-b border-line text-caption text-fg-secondary">
            <th scope="col" className="px-2 py-2 text-start font-medium">
              {t('label')}
            </th>
            <th scope="col" className="px-2 py-2 text-start font-medium">
              {t('apiName')}
            </th>
            <th scope="col" className="px-2 py-2 text-start font-medium">
              {t('default')}
            </th>
            <th scope="col" className="px-2 py-2 text-start font-medium">
              {t('active')}
            </th>
            <th scope="col" className="px-2 py-2">
              <span className="sr-only">{t('order')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((v, i) => (
            <tr key={`${v.apiValue}-${String(i)}`} className="border-b border-line-subtle">
              <td className="px-2 py-1.5">
                <Input
                  aria-label={t('valueLabel', { n: i + 1 })}
                  value={v.label}
                  disabled={!canChange}
                  onChange={(e) => {
                    update(i, { label: e.target.value });
                  }}
                />
              </td>
              <td className="px-2 py-1.5 font-mono text-fg-secondary">
                {v.saved ? v.apiValue : toApiName(v.label, 80)}
              </td>
              <td className="px-2 py-1.5">
                <Checkbox
                  aria-label={t('defaultFor', { value: v.label })}
                  checked={v.isDefault}
                  disabled={!canChange || !v.active}
                  onCheckedChange={(c) => {
                    update(i, { isDefault: c === true });
                  }}
                />
              </td>
              <td className="px-2 py-1.5">
                <Checkbox
                  aria-label={t('activeFor', { value: v.label })}
                  checked={v.active}
                  disabled={!canChange}
                  onCheckedChange={(c) => {
                    update(i, { active: c === true, ...(c === true ? {} : { isDefault: false }) });
                  }}
                />
              </td>
              <td className="px-2 py-1.5">
                <span className="flex gap-1">
                  <IconButton
                    label={t('moveUp', { value: v.label })}
                    size="sm"
                    variant="ghost"
                    disabled={!canChange || i === 0}
                    onClick={() => {
                      move(i, -1);
                    }}
                  >
                    <ArrowUp />
                  </IconButton>
                  <IconButton
                    label={t('moveDown', { value: v.label })}
                    size="sm"
                    variant="ghost"
                    disabled={!canChange || i === rows.length - 1}
                    onClick={() => {
                      move(i, 1);
                    }}
                  >
                    <ArrowDown />
                  </IconButton>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {canChange ? (
        <div className="flex gap-2">
          <Button
            icon={<Plus />}
            onClick={() => {
              setRows((prev) => [
                ...prev,
                {
                  apiValue: '',
                  label: '',
                  active: true,
                  isDefault: false,
                  category: null,
                  saved: false,
                },
              ]);
            }}
          >
            {t('addValue')}
          </Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={rows.some((r) => !r.saved && !toApiName(r.label, 80))}
            onClick={() => void save()}
          >
            {t('saveValues')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/** One field's settings (§5.2): standard fields take a label, description, help and history. */
export function FieldDetailPage({ object, field: apiName }: { object: string; field: string }) {
  const t = useTranslations('setup.objects');
  const ts = useTranslations('setup.common');
  const toast = useToast();
  const router = useRouter();
  const problem = useSetupProblem();
  const canChange = useHasPermission('customize_application');
  const path = `/v1/setup/objects/${object}/fields/${apiName}`;
  // There is no single-field read: the field comes from the object's list.
  const {
    data: list,
    failure,
    reload,
  } = useResource<{ items: FieldSetting[] }>(`/v1/setup/objects/${object}/fields`);
  const field = list?.items.find((f) => f.apiName === apiName) ?? null;
  const { data: described } = useResource<DescribedObject>(`/v1/objects/${object}/describe`);
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [helpText, setHelpText] = useState('');
  const [required, setRequired] = useState(false);
  const [trackHistory, setTrackHistory] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const labels = new Map((described?.fields ?? []).map((f) => [f.name, f.label]));

  useEffect(() => {
    if (!field) return;
    setLabel(field.label ?? '');
    setDescription(field.description ?? '');
    setHelpText(field.helpText ?? '');
    setRequired(field.required);
    setTrackHistory(field.trackHistory);
  }, [field]);

  if (!list) return <ResourceState failure={failure} loading />;
  if (!field)
    return (
      <div className="p-[var(--page-padding)]">
        <Banner tone="danger">{ts('notFound')}</Banner>
      </div>
    );
  const shown = fieldLabel(field, labels);

  const save = async () => {
    setError('');
    const r = await cellApi<FieldSetting>('PATCH', path, {
      version: field.version,
      label: label.trim() || null,
      description: description.trim() || null,
      helpText: helpText.trim() || null,
      trackHistory,
      ...(field.custom ? { required } : {}),
    });
    if (!r.ok) {
      setError(problem(r));
      return;
    }
    reload();
    toast({ tone: 'success', title: ts('saved') });
  };

  return (
    <>
      <SetupHeader
        title={shown}
        description={`${object}.${field.apiName}`}
        breadcrumb={<BackLink href={`/setup/objects/${object}`}>{t('fields')}</BackLink>}
        actions={
          canChange && field.custom ? (
            <Button
              variant="danger"
              icon={<Trash2 />}
              onClick={() => {
                setDeleting(true);
              }}
            >
              {ts('delete')}
            </Button>
          ) : null
        }
      />
      <div className="grid max-w-3xl gap-8 p-[var(--page-padding)]">
        <section aria-labelledby="field-settings" className="grid gap-4">
          <h2 id="field-settings" className="text-title-3 text-fg">
            {t('settings')}
          </h2>
          <div className="flex flex-wrap gap-2">
            <StatusChip tone={field.custom ? 'info' : 'neutral'}>
              {field.custom ? t('custom') : t('standard')}
            </StatusChip>
            <StatusChip>
              {Object.hasOwn(TYPE_LABEL, field.type)
                ? t(TYPE_LABEL[field.type as keyof typeof TYPE_LABEL])
                : field.type}
            </StatusChip>
            {field.indexStatus ? <StatusChip tone="warning">{t('indexPending')}</StatusChip> : null}
          </div>
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <FormField label={t('label')} helper={field.custom ? undefined : t('standardLabelHelp')}>
            <Input
              value={label}
              placeholder={labels.get(field.apiName) ?? field.apiName}
              maxLength={80}
              disabled={!canChange}
              onChange={(e) => {
                setLabel(e.target.value);
              }}
            />
          </FormField>
          <FormField label={t('wizard.helpText')}>
            <Input
              value={helpText}
              maxLength={1000}
              disabled={!canChange}
              onChange={(e) => {
                setHelpText(e.target.value);
              }}
            />
          </FormField>
          <FormField label={ts('description')}>
            <Textarea
              rows={3}
              value={description}
              maxLength={1000}
              disabled={!canChange}
              onChange={(e) => {
                setDescription(e.target.value);
              }}
            />
          </FormField>
          <Checkbox
            label={t('wizard.required')}
            checked={required}
            disabled={!canChange || !field.custom}
            onCheckedChange={(c) => {
              setRequired(c === true);
            }}
          />
          <Checkbox
            label={t('wizard.trackHistory')}
            checked={trackHistory}
            disabled={!canChange}
            onCheckedChange={(c) => {
              setTrackHistory(c === true);
            }}
          />
          {canChange ? (
            <Button variant="primary" className="justify-self-start" onClick={() => void save()}>
              {ts('saveChanges')}
            </Button>
          ) : null}
        </section>
        {HAS_VALUES.has(field.type) ? (
          <PicklistEditor object={object} field={field} onSaved={reload} />
        ) : null}
      </div>
      <DeleteDialog
        open={deleting}
        onOpenChange={setDeleting}
        name={shown}
        path={path}
        inUse={t('fieldInUse')}
        onDeleted={() => {
          router.push(`/setup/objects/${object}`);
        }}
      />
    </>
  );
}
