'use client';

import type {
  CheckFormulaResult,
  CompactLayoutDto,
  PathDto,
  RecordTypeDto,
  ValidationRuleDto,
} from '@sm/contracts';
import {
  Banner,
  Button,
  Checkbox,
  Dialog,
  FormField,
  IconButton,
  Input,
  Select,
  StatusChip,
  Switch,
  Textarea,
  useToast,
} from '@sm/ui';
import { ArrowUp, Plus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import type { z } from 'zod';

import { cellApi } from '../../../lib/cell-api';
import type { DescribedObject } from '../../records/fields';
import { ResourceState, useResource } from '../common';
import { useHasPermission } from '../setup-shell';
import { useSetupProblem } from '../use-problem';
import type { FieldSetting } from './objects-pages';
import { toApiName } from './types';

type Compact = z.infer<typeof CompactLayoutDto>;
type PathSetting = z.infer<typeof PathDto>;
type RecordType = z.infer<typeof RecordTypeDto>;
type Rule = z.infer<typeof ValidationRuleDto>;
type Check = z.infer<typeof CheckFormulaResult>;

const MAX_COMPACT = 7;
const MAX_KEY_FIELDS = 5;
const CHECK_DEBOUNCE_MS = 300;

function useLabels(object: string) {
  const { data } = useResource<DescribedObject>(`/v1/objects/${object}/describe`);
  const fields = data?.fields ?? [];
  return { fields, labelOf: (n: string) => fields.find((f) => f.name === n)?.label ?? n };
}

/** An ordered pick of fields: checked fields in order, with up/down to reorder (keyboard path). */
function OrderedFieldPicker({
  label,
  options,
  value,
  max,
  disabled,
  onChange,
  labelOf,
}: {
  label: string;
  options: { name: string; label: string }[];
  value: string[];
  max: number;
  disabled: boolean;
  onChange: (next: string[]) => void;
  labelOf: (name: string) => string;
}) {
  const t = useTranslations('setup.layouts');
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-label text-fg-secondary">{label}</legend>
      <ol className="grid gap-1">
        {value.map((name, i) => (
          <li key={name} className="flex items-center gap-2 text-body-sm">
            <span className="w-5 text-end tabular-nums text-fg-secondary">{i + 1}.</span>
            <span className="flex-1 text-fg">{labelOf(name)}</span>
            {!disabled ? (
              <>
                <IconButton
                  size="sm"
                  variant="ghost"
                  disabled={i === 0}
                  label={t('moveUp', { field: labelOf(name) })}
                  onClick={() => {
                    const next = [...value];
                    next.splice(i - 1, 0, ...next.splice(i, 1));
                    onChange(next);
                  }}
                >
                  <ArrowUp />
                </IconButton>
                <IconButton
                  size="sm"
                  variant="ghost"
                  label={t('remove', { field: labelOf(name) })}
                  onClick={() => {
                    onChange(value.filter((v) => v !== name));
                  }}
                >
                  <X />
                </IconButton>
              </>
            ) : null}
          </li>
        ))}
      </ol>
      {!disabled && value.length < max ? (
        <div className="w-64">
          <Select
            aria-label={t('addField')}
            placeholder={t('addField')}
            options={options
              .filter((o) => !value.includes(o.name))
              .map((o) => ({ value: o.name, label: o.label }))}
            value=""
            onValueChange={(v) => {
              if (v) onChange([...value, v]);
            }}
          />
        </div>
      ) : null}
    </fieldset>
  );
}

/** Compact layouts (§5.4): the 1–7 fields of the Highlights Panel and hover cards. */
export function CompactLayoutsTab({ object }: { object: string }) {
  const t = useTranslations('setup.layouts');
  const ts = useTranslations('setup.common');
  const toast = useToast();
  const problem = useSetupProblem();
  const canChange = useHasPermission('customize_application');
  const path = `/v1/setup/objects/${object}/compact-layouts`;
  const { data, failure, reload } = useResource<{ items: Compact[] }>(path);
  const { fields, labelOf } = useLabels(object);
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  useEffect(() => {
    if (data) setDrafts(Object.fromEntries(data.items.map((c) => [c.id, c.fields])));
  }, [data]);
  if (!data) return <ResourceState failure={failure} loading />;
  const save = async (c: Compact) => {
    const r = await cellApi('PATCH', `${path}/${c.id}`, {
      version: c.version,
      fields: drafts[c.id],
    });
    if (r.ok) {
      toast({ tone: 'success', title: ts('saved') });
      reload();
    } else toast({ tone: 'error', title: problem(r) });
  };
  return (
    <div className="grid gap-6">
      {data.items.map((c) => (
        <section
          key={c.id}
          aria-label={c.name}
          className="grid gap-3 rounded-md border border-line p-4"
        >
          <h3 className="flex items-center gap-2 text-title-3 text-fg">
            {c.name} {c.isDefault ? <StatusChip tone="info">{t('default')}</StatusChip> : null}
          </h3>
          <OrderedFieldPicker
            label={t('compactFields', { max: MAX_COMPACT })}
            options={fields.map((f) => ({ name: f.name, label: f.label }))}
            value={drafts[c.id] ?? []}
            max={MAX_COMPACT}
            disabled={!canChange}
            labelOf={labelOf}
            onChange={(next) => {
              setDrafts((d) => ({ ...d, [c.id]: next }));
            }}
          />
          {canChange ? (
            <Button
              variant="primary"
              className="justify-self-start"
              disabled={(drafts[c.id] ?? []).length === 0}
              onClick={() => void save(c)}
            >
              {ts('saveChanges')}
            </Button>
          ) : null}
        </section>
      ))}
    </div>
  );
}

/** Path settings (§5.6): per record type and picklist, key fields and guidance for each value. */
export function PathsTab({ object }: { object: string }) {
  const t = useTranslations('setup.paths');
  const ts = useTranslations('setup.common');
  const toast = useToast();
  const problem = useSetupProblem();
  const canChange = useHasPermission('customize_application');
  const base = `/v1/setup/objects/${object}`;
  const { data: types } = useResource<{ items: RecordType[] }>(`${base}/record-types`);
  const { data: paths, reload } = useResource<{ items: PathSetting[] }>(`${base}/paths`);
  const { data: settings, failure } = useResource<{ items: FieldSetting[] }>(`${base}/fields`);
  const { fields, labelOf } = useLabels(object);
  const [recordType, setRecordType] = useState('');
  const [field, setField] = useState('');
  const [active, setActive] = useState(true);
  const [steps, setSteps] = useState<Record<string, { keyFields: string[]; guidance: string }>>({});

  const picklists = (settings?.items ?? []).filter((f) => f.type === 'picklist');
  useEffect(() => {
    if (!recordType && types?.items[0])
      setRecordType(types.items.find((r) => r.isDefault)?.id ?? types.items[0].id);
  }, [types, recordType]);
  useEffect(() => {
    if (!field && picklists[0])
      setField(
        picklists.find((f) => f.apiName === 'status' || f.apiName === 'stage')?.apiName ??
          picklists[0].apiName,
      );
  }, [picklists, field]);
  useEffect(() => {
    const existing = paths?.items.find((p) => p.recordTypeId === recordType && p.field === field);
    setActive(existing?.active ?? true);
    setSteps(existing?.steps ?? {});
  }, [paths, recordType, field]);

  if (!settings || !types) return <ResourceState failure={failure} loading />;
  const values =
    picklists.find((f) => f.apiName === field)?.picklistValues.filter((v) => v.active) ?? [];
  const existing = paths?.items.find((p) => p.recordTypeId === recordType && p.field === field);

  const save = async () => {
    const r = await cellApi('PUT', `${base}/paths/${recordType}/${field}`, { active, steps });
    if (r.ok) {
      toast({ tone: 'success', title: ts('saved') });
      reload();
    } else toast({ tone: 'error', title: problem(r) });
  };
  const remove = async () => {
    const r = await cellApi('DELETE', `${base}/paths/${recordType}/${field}`);
    if (r.ok) {
      toast({ tone: 'success', title: t('removed') });
      reload();
    } else toast({ tone: 'error', title: problem(r) });
  };

  if (picklists.length === 0)
    return <p className="text-body-sm text-fg-secondary">{t('noPicklists')}</p>;
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end gap-4">
        <div className="w-56">
          <FormField label={t('recordType')}>
            <Select
              options={types.items.map((r) => ({ value: r.id, label: r.name }))}
              {...(recordType ? { value: recordType } : {})}
              onValueChange={setRecordType}
            />
          </FormField>
        </div>
        <div className="w-56">
          <FormField label={t('field')}>
            <Select
              options={picklists.map((f) => ({ value: f.apiName, label: labelOf(f.apiName) }))}
              {...(field ? { value: field } : {})}
              onValueChange={setField}
            />
          </FormField>
        </div>
        <Switch
          label={t('active')}
          checked={active}
          disabled={!canChange}
          onCheckedChange={setActive}
        />
      </div>
      {values.map((v) => {
        const step = steps[v.apiValue] ?? { keyFields: [], guidance: '' };
        const set = (change: Partial<typeof step>) => {
          setSteps((s) => ({ ...s, [v.apiValue]: { ...step, ...change } }));
        };
        return (
          <section
            key={v.apiValue}
            aria-label={v.label ?? v.apiValue}
            className="grid gap-3 rounded-md border border-line p-4"
          >
            <h3 className="text-title-3 text-fg">{v.label ?? labelOf(v.apiValue)}</h3>
            <OrderedFieldPicker
              label={t('keyFields', { max: MAX_KEY_FIELDS })}
              options={fields.map((f) => ({ name: f.name, label: f.label }))}
              value={step.keyFields}
              max={MAX_KEY_FIELDS}
              disabled={!canChange}
              labelOf={labelOf}
              onChange={(keyFields) => {
                set({ keyFields });
              }}
            />
            <FormField label={t('guidance')}>
              <Textarea
                rows={3}
                maxLength={2000}
                value={step.guidance}
                disabled={!canChange}
                onChange={(e) => {
                  set({ guidance: e.target.value });
                }}
              />
            </FormField>
          </section>
        );
      })}
      {canChange ? (
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => void save()}>
            {ts('saveChanges')}
          </Button>
          {existing ? (
            <Button variant="danger" onClick={() => void remove()}>
              {t('remove')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const ERROR_KEY = {
  unknown_field: 'errors.unknownField',
  unknown_function: 'errors.unknownFunction',
  unknown_global: 'errors.unknownGlobal',
  wrong_result_type: 'errors.wrongResultType',
  type_mismatch: 'errors.typeMismatch',
  wrong_argument_count: 'errors.wrongArgumentCount',
  unexpected_token: 'errors.syntax',
  unexpected_end: 'errors.syntax',
  unexpected_character: 'errors.syntax',
  unterminated_text: 'errors.syntax',
  picklist_needs_function: 'errors.picklistNeedsFunction',
  empty: 'errors.empty',
} as const;

/** A formula box that type-checks as you type and says what is wrong, and where (§5.5). */
function FormulaEditor({
  object,
  value,
  onChange,
  onChecked,
}: {
  object: string;
  value: string;
  onChange: (value: string) => void;
  onChecked: (ok: boolean) => void;
}) {
  const t = useTranslations('setup.rules');
  const [check, setCheck] = useState<Check | null>(null);
  useEffect(() => {
    if (!value.trim()) {
      setCheck(null);
      onChecked(false);
      return;
    }
    const timer = setTimeout(() => {
      void cellApi<Check>('POST', `/v1/setup/objects/${object}/formula/check`, {
        formula: value,
        expected: 'Boolean',
      }).then((r) => {
        if (!r.ok) return;
        setCheck(r.data);
        onChecked(r.data.ok);
      });
    }, CHECK_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [value, object, onChecked]);
  const err = check?.error ?? null;
  const key = err
    ? Object.hasOwn(ERROR_KEY, err.code)
      ? ERROR_KEY[err.code as keyof typeof ERROR_KEY]
      : 'errors.generic'
    : null;
  const name = err ? String(err.params['name'] ?? '') : '';
  const message =
    err && key
      ? t(key, {
          name,
          expected: String(err.params['expected'] ?? ''),
          found: String(err.params['found'] ?? ''),
          position: err.start + 1,
        })
      : undefined;
  return (
    <FormField
      label={t('formula')}
      required
      error={message}
      helper={check?.ok ? t('valid') : t('formulaHelp')}
    >
      <Textarea
        rows={5}
        dir="ltr"
        spellCheck={false}
        className="font-mono"
        value={value}
        maxLength={5000}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
    </FormField>
  );
}

/** Validation rules (§5.5): a Boolean formula that blocks the save when true, with its message. */
export function ValidationRulesTab({ object }: { object: string }) {
  const t = useTranslations('setup.rules');
  const ts = useTranslations('setup.common');
  const tc = useTranslations('common.actions');
  const toast = useToast();
  const problem = useSetupProblem();
  const canChange = useHasPermission('customize_application');
  const path = `/v1/setup/objects/${object}/validation-rules`;
  const { data, failure, reload } = useResource<{ items: Rule[] }>(path);
  const { fields } = useLabels(object);
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const [apiName, setApiName] = useState('');
  const [formula, setFormula] = useState('');
  const [message, setMessage] = useState('');
  const [errorField, setErrorField] = useState('');
  const [active, setActive] = useState(true);
  const [valid, setValid] = useState(false);
  const [error, setError] = useState('');

  const open = (rule: Rule | 'new') => {
    setEditing(rule);
    setError('');
    setApiName(rule === 'new' ? '' : rule.apiName);
    setFormula(rule === 'new' ? '' : rule.formula);
    setMessage(rule === 'new' ? '' : rule.errorMessage);
    setErrorField(rule === 'new' ? '' : (rule.errorField ?? ''));
    setActive(rule === 'new' ? true : rule.active);
  };
  const save = async () => {
    const body = {
      formula,
      errorMessage: message.trim(),
      errorField: errorField || null,
      active,
    };
    const r =
      editing === 'new'
        ? await cellApi('POST', path, { apiName, ...body })
        : editing
          ? await cellApi('PATCH', `${path}/${editing.id}`, { version: editing.version, ...body })
          : null;
    if (!r) return;
    if (!r.ok) {
      setError(problem(r, { conflict: ts('nameTaken') }));
      return;
    }
    toast({ tone: 'success', title: ts('saved') });
    setEditing(null);
    reload();
  };

  if (!data) return <ResourceState failure={failure} loading />;
  return (
    <div className="grid gap-3">
      {canChange ? (
        <Button
          variant="primary"
          icon={<Plus />}
          className="justify-self-end"
          onClick={() => {
            open('new');
          }}
        >
          {t('new')}
        </Button>
      ) : null}
      {data.items.length === 0 ? (
        <p className="text-body-sm text-fg-secondary">{t('none')}</p>
      ) : (
        <table className="w-full border-collapse text-body-sm">
          <thead>
            <tr className="border-b border-line text-caption text-fg-secondary">
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('apiName')}
              </th>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('message')}
              </th>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('status')}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((r) => (
              <tr key={r.id} className="border-b border-line-subtle hover:bg-hover">
                <td className="px-3 py-2">
                  <button
                    type="button"
                    className="font-mono font-medium text-link underline-offset-4 hover:underline"
                    onClick={() => {
                      open(r);
                    }}
                  >
                    {r.apiName}
                  </button>
                </td>
                <td className="px-3 py-2 text-fg-secondary">{r.errorMessage}</td>
                <td className="px-3 py-2">
                  <StatusChip tone={r.active ? 'success' : 'neutral'}>
                    {r.active ? t('active') : t('inactive')}
                  </StatusChip>
                </td>
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
        size="lg"
        title={editing === 'new' ? t('new') : t('edit')}
        closeLabel={tc('close')}
        footer={
          canChange ? (
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
                disabled={!valid || !message.trim() || (editing === 'new' && !apiName)}
                onClick={() => void save()}
              >
                {tc('save')}
              </Button>
            </>
          ) : undefined
        }
      >
        <div className="grid gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <FormField label={t('apiName')} required>
            <Input
              value={apiName}
              dir="ltr"
              className="font-mono"
              disabled={editing !== 'new'}
              onChange={(e) => {
                setApiName(toApiName(e.target.value, 40));
              }}
            />
          </FormField>
          <FormulaEditor
            object={object}
            value={formula}
            onChange={setFormula}
            onChecked={setValid}
          />
          <FormField label={t('message')} required helper={t('messageHelp')}>
            <Input
              value={message}
              maxLength={255}
              onChange={(e) => {
                setMessage(e.target.value);
              }}
            />
          </FormField>
          <FormField label={t('errorField')}>
            <Select
              options={[
                { value: '__top__', label: t('topOfPage') },
                ...fields.map((f) => ({ value: f.name, label: f.label })),
              ]}
              value={errorField || '__top__'}
              onValueChange={(v) => {
                setErrorField(v === '__top__' ? '' : v);
              }}
            />
          </FormField>
          <Checkbox
            label={t('active')}
            checked={active}
            onCheckedChange={(c) => {
              setActive(c === true);
            }}
          />
        </div>
      </Dialog>
    </div>
  );
}

/** Field history settings (§5.2): which fields keep a change history. */
export function FieldHistoryTab({ object }: { object: string }) {
  const t = useTranslations('setup.history');
  const ts = useTranslations('setup.common');
  const toast = useToast();
  const problem = useSetupProblem();
  const canChange = useHasPermission('customize_application');
  const path = `/v1/setup/objects/${object}/fields`;
  const { data, failure, reload } = useResource<{ items: FieldSetting[] }>(path);
  const { labelOf } = useLabels(object);
  if (!data) return <ResourceState failure={failure} loading />;
  const trackable = data.items
    .filter((f) => !f.system && f.type !== 'long_text' && f.type !== 'id')
    .sort((a, b) => labelOf(a.apiName).localeCompare(labelOf(b.apiName)));
  const tracked = trackable.filter((f) => f.trackHistory).length;
  const toggle = async (f: FieldSetting, on: boolean) => {
    const r = await cellApi('PATCH', `${path}/${f.apiName}`, {
      version: f.version,
      trackHistory: on,
    });
    if (r.ok) {
      toast({ tone: 'success', title: ts('saved') });
      reload();
    } else toast({ tone: 'error', title: problem(r) });
  };
  return (
    <div className="grid gap-3">
      <p className="text-body-sm text-fg-secondary">{t('help', { count: tracked })}</p>
      <div
        role="group"
        aria-label={t('label')}
        className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
      >
        {trackable.map((f) => (
          <Checkbox
            key={f.apiName}
            label={labelOf(f.apiName)}
            checked={f.trackHistory}
            disabled={!canChange}
            onCheckedChange={(c) => void toggle(f, c === true)}
          />
        ))}
      </div>
    </div>
  );
}
