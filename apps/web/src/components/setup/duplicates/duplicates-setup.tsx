'use client';

import type { DuplicateJobDto, DuplicateRuleDto, MatchingRuleDto } from '@sm/contracts';
import {
  Banner,
  Button,
  Checkbox,
  Dialog,
  FormField,
  IconButton,
  Input,
  Radio,
  RadioGroup,
  Select,
  StatusChip,
  Tabs,
  useToast,
} from '@sm/ui';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import type { z } from 'zod';

import { cellApi } from '../../../lib/cell-api';
import type { DescribedObject } from '../../records/fields';
import { DeleteDialog, ResourceState, useResource } from '../common';
import { SetupHeader, useHasPermission } from '../setup-shell';
import { useSetupProblem } from '../use-problem';

type MatchingRule = z.infer<typeof MatchingRuleDto>;
type DuplicateRule = z.infer<typeof DuplicateRuleDto>;
type Job = z.infer<typeof DuplicateJobDto>;
type Condition = MatchingRule['conditions'][number];
type DedupeObject = MatchingRule['object'];

const OBJECTS: DedupeObject[] = ['lead', 'contact', 'account'];
const METHODS: Condition['method'][] = [
  'exact',
  'fuzzy',
  'phone',
  'email',
  'email_domain_name',
  'company',
];

/** A method as its message key (`setup.duplicates.methods.*`). */
const methodKey = (m: Condition['method']) =>
  m === 'email_domain_name' ? ('emailDomainName' as const) : m;

/** Field lists of the three objects, for the condition builder. */
function useFieldsOf(object: DedupeObject) {
  const [describe, setDescribe] = useState<DescribedObject | null>(null);
  useEffect(() => {
    void cellApi<DescribedObject>('GET', `/v1/objects/${object}/describe`).then((r) => {
      if (r.ok) setDescribe(r.data);
    });
  }, [object]);
  return describe;
}

/**
 * Setup → Matching & duplicate rules (§7.2): matching rules (how records compare), duplicate
 * rules (Block or Alert on create and edit, profiles that may bypass), and duplicate jobs
 * (scans feeding the review queue).
 */
export function DuplicatesSetup() {
  const t = useTranslations('setup.duplicates');
  const [tab, setTab] = useState('matching');
  return (
    <>
      <SetupHeader title={t('title')} description={t('description')} />
      <div className="p-[var(--page-padding)]">
        <Tabs
          label={t('title')}
          value={tab}
          onValueChange={setTab}
          items={[
            { value: 'matching', label: t('tabs.matching'), content: <MatchingRules /> },
            { value: 'duplicate', label: t('tabs.duplicate'), content: <DuplicateRules /> },
            { value: 'jobs', label: t('tabs.jobs'), content: <Jobs /> },
          ]}
        />
      </div>
    </>
  );
}

function MatchingRules() {
  const t = useTranslations('setup.duplicates.matching');
  const to = useTranslations('setup.duplicates');
  const canChange = useHasPermission('customize_application');
  const { data, failure, reload } = useResource<{ items: MatchingRule[] }>(
    '/v1/setup/matching-rules',
  );
  const [editing, setEditing] = useState<MatchingRule | 'new' | null>(null);
  const [deleting, setDeleting] = useState<MatchingRule | null>(null);
  if (!data) return <ResourceState failure={failure} loading />;
  return (
    <section aria-labelledby="matching-title" className="grid gap-3 pt-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="matching-title" className="text-title-3 text-fg">
          {t('title')}
        </h2>
        {canChange ? (
          <Button
            icon={<Plus />}
            onClick={() => {
              setEditing('new');
            }}
          >
            {t('new')}
          </Button>
        ) : null}
      </div>
      {data.items.length === 0 ? (
        <p className="text-body-sm text-fg-secondary">{t('none')}</p>
      ) : (
        <table className="w-full border-collapse text-body-sm">
          <thead>
            <tr className="border-b border-line text-caption text-fg-secondary">
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('name')}
              </th>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('object')}
              </th>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('conditions')}
              </th>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('status')}
              </th>
              <th scope="col" className="px-3 py-2">
                <span className="sr-only">{t('actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((r) => (
              <tr key={r.id} className="border-b border-line-subtle">
                <td className="px-3 py-2 text-fg">{r.name}</td>
                <td className="px-3 py-2 text-fg">{to(`objects.${r.object}`)}</td>
                <td className="px-3 py-2 text-fg-secondary">
                  {r.conditions
                    .map((c) => `${c.field} (${to(`methods.${methodKey(c.method)}`)})`)
                    .join(', ')}
                </td>
                <td className="px-3 py-2">
                  <StatusChip tone={r.active ? 'success' : 'neutral'}>
                    {r.active ? t('active') : t('inactive')}
                  </StatusChip>
                </td>
                <td className="px-3 py-2 text-end">
                  {canChange ? (
                    <span className="inline-flex gap-1">
                      <IconButton
                        size="sm"
                        variant="ghost"
                        label={t('edit', { name: r.name })}
                        onClick={() => {
                          setEditing(r);
                        }}
                      >
                        <Pencil />
                      </IconButton>
                      <IconButton
                        size="sm"
                        variant="ghost"
                        label={t('delete', { name: r.name })}
                        onClick={() => {
                          setDeleting(r);
                        }}
                      >
                        <Trash2 />
                      </IconButton>
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing ? (
        <MatchingRuleDialog
          rule={editing === 'new' ? null : editing}
          onClose={(saved) => {
            setEditing(null);
            if (saved) reload();
          }}
        />
      ) : null}
      <DeleteDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        name={deleting?.name ?? ''}
        path={`/v1/setup/matching-rules/${deleting?.id ?? ''}`}
        inUse={t('inUse')}
        onDeleted={() => {
          setDeleting(null);
          reload();
        }}
      />
    </section>
  );
}

function MatchingRuleDialog({
  rule,
  onClose,
}: {
  rule: MatchingRule | null;
  onClose: (saved: boolean) => void;
}) {
  const t = useTranslations('setup.duplicates.matching');
  const to = useTranslations('setup.duplicates');
  const tc = useTranslations('common.actions');
  const problem = useSetupProblem();
  const [object, setObject] = useState<DedupeObject>(rule?.object ?? 'lead');
  const [name, setName] = useState(rule?.name ?? '');
  const [active, setActive] = useState(rule?.active ?? true);
  const [matchBlank, setMatchBlank] = useState(rule?.matchBlank ?? false);
  const [conditions, setConditions] = useState<Condition[]>(
    rule?.conditions ?? [{ field: 'email', method: 'email' }],
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [probe, setProbe] = useState<Record<string, string>>({});
  const [found, setFound] = useState<{ id: string; name: string | null; score: number }[] | null>(
    null,
  );
  const describe = useFieldsOf(object);
  const fieldOptions = (describe?.fields ?? [])
    .filter((f) => !['id'].includes(f.name))
    .map((f) => ({ value: f.name, label: f.label }));

  const save = async () => {
    setSaving(true);
    setError('');
    const r = rule
      ? await cellApi('PATCH', `/v1/setup/matching-rules/${rule.id}`, {
          name,
          active,
          matchBlank,
          conditions,
          version: rule.version,
        })
      : await cellApi('POST', '/v1/setup/matching-rules', {
          object,
          name,
          active,
          matchBlank,
          conditions,
        });
    setSaving(false);
    if (!r.ok) {
      setError(problem(r));
      return;
    }
    onClose(true);
  };
  const test = async () => {
    if (!rule) return;
    const r = await cellApi<{ matches: { id: string; name: string | null; score: number }[] }>(
      'POST',
      `/v1/setup/matching-rules/${rule.id}/test`,
      { fields: probe },
    );
    if (r.ok) setFound(r.data.matches);
    else setError(problem(r));
  };

  return (
    <Dialog
      size="lg"
      open
      onOpenChange={(open) => {
        if (!open) onClose(false);
      }}
      title={rule ? t('editTitle', { name: rule.name }) : t('newTitle')}
      closeLabel={tc('close')}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              onClose(false);
            }}
          >
            {tc('cancel')}
          </Button>
          <Button
            variant="primary"
            loading={saving}
            loadingLabel={tc('save')}
            disabled={!name.trim() || conditions.length === 0}
            onClick={() => void save()}
          >
            {tc('save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? (
          <Banner tone="danger" role="alert">
            {error}
          </Banner>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('name')} required>
            <Input
              value={name}
              maxLength={80}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
          </FormField>
          <FormField label={t('object')}>
            <Select
              disabled={rule !== null}
              options={OBJECTS.map((o) => ({ value: o, label: to(`objects.${o}`) }))}
              value={object}
              onValueChange={(v) => {
                setObject(v as DedupeObject);
              }}
            />
          </FormField>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-label text-fg">{t('conditions')}</legend>
          <p className="text-caption text-fg-secondary">{t('conditionsHint')}</p>
          {conditions.map((c, i) => (
            <div
              key={i}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6rem_auto] items-end gap-2"
            >
              <FormField label={t('field')}>
                <Select
                  options={fieldOptions}
                  value={c.field}
                  onValueChange={(v) => {
                    setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, field: v } : x)));
                  }}
                />
              </FormField>
              <FormField label={t('method')}>
                <Select
                  options={METHODS.map((m) => ({ value: m, label: to(`methods.${methodKey(m)}`) }))}
                  value={c.method}
                  onValueChange={(v) => {
                    setConditions((cs) =>
                      cs.map((x, j) =>
                        j === i ? { field: x.field, method: v as Condition['method'] } : x,
                      ),
                    );
                  }}
                />
              </FormField>
              <FormField label={t('threshold')}>
                <Input
                  type="number"
                  min={0.3}
                  max={1}
                  step={0.05}
                  disabled={c.method !== 'fuzzy'}
                  value={c.method === 'fuzzy' ? String(c.threshold ?? 0.8) : ''}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, threshold: v } : x)));
                  }}
                />
              </FormField>
              <IconButton
                variant="ghost"
                label={t('removeCondition')}
                disabled={conditions.length === 1}
                onClick={() => {
                  setConditions((cs) => cs.filter((_, j) => j !== i));
                }}
              >
                <Trash2 />
              </IconButton>
            </div>
          ))}
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus />}
            className="self-start"
            disabled={conditions.length >= 10}
            onClick={() => {
              setConditions((cs) => [...cs, { field: 'last_name', method: 'exact' }]);
            }}
          >
            {t('addCondition')}
          </Button>
        </fieldset>
        <div className="flex flex-col gap-2">
          <Checkbox
            label={t('active')}
            checked={active}
            onCheckedChange={(v) => {
              setActive(v === true);
            }}
          />
          <Checkbox
            label={t('matchBlank')}
            checked={matchBlank}
            onCheckedChange={(v) => {
              setMatchBlank(v === true);
            }}
          />
        </div>
        {rule ? (
          <fieldset className="flex flex-col gap-2 rounded-md border border-line p-3">
            <legend className="px-1 text-label text-fg">{t('test')}</legend>
            <p className="text-caption text-fg-secondary">{t('testHint')}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {[...new Set(rule.conditions.map((c) => c.field))].map((f) => (
                <FormField key={f} label={describe?.fields.find((x) => x.name === f)?.label ?? f}>
                  <Input
                    value={probe[f] ?? ''}
                    onChange={(e) => {
                      setProbe((p) => ({ ...p, [f]: e.target.value }));
                    }}
                  />
                </FormField>
              ))}
            </div>
            <Button
              size="sm"
              variant="secondary"
              className="self-start"
              onClick={() => void test()}
            >
              {t('runTest')}
            </Button>
            {found ? (
              <p className="text-body-sm text-fg" aria-live="polite">
                {found.length
                  ? t('testFound', {
                      n: found.length,
                      names: found.map((m) => m.name ?? m.id).join(', '),
                    })
                  : t('testNone')}
              </p>
            ) : null}
          </fieldset>
        ) : null}
      </div>
    </Dialog>
  );
}

function DuplicateRules() {
  const t = useTranslations('setup.duplicates.duplicate');
  const to = useTranslations('setup.duplicates');
  const canChange = useHasPermission('customize_application');
  const { data, failure, reload } = useResource<{ items: DuplicateRule[] }>(
    '/v1/setup/duplicate-rules',
  );
  const [editing, setEditing] = useState<DuplicateRule | 'new' | null>(null);
  const [deleting, setDeleting] = useState<DuplicateRule | null>(null);
  if (!data) return <ResourceState failure={failure} loading />;
  return (
    <section aria-labelledby="duplicate-title" className="grid gap-3 pt-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="duplicate-title" className="text-title-3 text-fg">
          {t('title')}
        </h2>
        {canChange ? (
          <Button
            icon={<Plus />}
            onClick={() => {
              setEditing('new');
            }}
          >
            {t('new')}
          </Button>
        ) : null}
      </div>
      {data.items.length === 0 ? (
        <p className="text-body-sm text-fg-secondary">{t('none')}</p>
      ) : (
        <table className="w-full border-collapse text-body-sm">
          <thead>
            <tr className="border-b border-line text-caption text-fg-secondary">
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('name')}
              </th>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('object')}
              </th>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('matchingRule')}
              </th>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('action')}
              </th>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('status')}
              </th>
              <th scope="col" className="px-3 py-2">
                <span className="sr-only">{t('actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((r) => (
              <tr key={r.id} className="border-b border-line-subtle">
                <td className="px-3 py-2 text-fg">{r.name}</td>
                <td className="px-3 py-2 text-fg">{to(`objects.${r.object}`)}</td>
                <td className="px-3 py-2 text-fg">{r.matchingRule.name}</td>
                <td className="px-3 py-2">
                  <StatusChip tone={r.action === 'BLOCK' ? 'danger' : 'warning'}>
                    {r.action === 'BLOCK' ? t('block') : t('alert')}
                  </StatusChip>
                </td>
                <td className="px-3 py-2">
                  <StatusChip tone={r.active ? 'success' : 'neutral'}>
                    {r.active ? t('active') : t('inactive')}
                  </StatusChip>
                </td>
                <td className="px-3 py-2 text-end">
                  {canChange ? (
                    <span className="inline-flex gap-1">
                      <IconButton
                        size="sm"
                        variant="ghost"
                        label={t('edit', { name: r.name })}
                        onClick={() => {
                          setEditing(r);
                        }}
                      >
                        <Pencil />
                      </IconButton>
                      <IconButton
                        size="sm"
                        variant="ghost"
                        label={t('delete', { name: r.name })}
                        onClick={() => {
                          setDeleting(r);
                        }}
                      >
                        <Trash2 />
                      </IconButton>
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing ? (
        <DuplicateRuleDialog
          rule={editing === 'new' ? null : editing}
          onClose={(saved) => {
            setEditing(null);
            if (saved) reload();
          }}
        />
      ) : null}
      <DeleteDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        name={deleting?.name ?? ''}
        path={`/v1/setup/duplicate-rules/${deleting?.id ?? ''}`}
        inUse={t('deleteRefused')}
        onDeleted={() => {
          setDeleting(null);
          reload();
        }}
      />
    </section>
  );
}

function DuplicateRuleDialog({
  rule,
  onClose,
}: {
  rule: DuplicateRule | null;
  onClose: (saved: boolean) => void;
}) {
  const t = useTranslations('setup.duplicates.duplicate');
  const to = useTranslations('setup.duplicates');
  const tc = useTranslations('common.actions');
  const problem = useSetupProblem();
  const matching = useResource<{ items: MatchingRule[] }>('/v1/setup/matching-rules');
  const profiles = useResource<{ items: { id: string; name: string }[] }>('/v1/profiles');
  const [object, setObject] = useState<DedupeObject>(rule?.object ?? 'lead');
  const [name, setName] = useState(rule?.name ?? '');
  const [matchingRuleId, setMatchingRuleId] = useState(rule?.matchingRule.id ?? '');
  const [action, setAction] = useState<'BLOCK' | 'ALERT'>(rule?.action ?? 'ALERT');
  const [onCreate, setOnCreate] = useState(rule?.onCreate ?? true);
  const [onEdit, setOnEdit] = useState(rule?.onEdit ?? true);
  const [bypass, setBypass] = useState<string[]>(rule?.bypassProfileIds ?? []);
  const [active, setActive] = useState(rule?.active ?? true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const rules = (matching.data?.items ?? []).filter((r) => r.object === object);

  const save = async () => {
    setSaving(true);
    setError('');
    const body = {
      name,
      matchingRuleId,
      action,
      onCreate,
      onEdit,
      bypassProfileIds: bypass,
      active,
    };
    const r = rule
      ? await cellApi('PATCH', `/v1/setup/duplicate-rules/${rule.id}`, {
          ...body,
          version: rule.version,
        })
      : await cellApi('POST', '/v1/setup/duplicate-rules', { ...body, object });
    setSaving(false);
    if (!r.ok) {
      setError(problem(r));
      return;
    }
    onClose(true);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose(false);
      }}
      title={rule ? t('editTitle', { name: rule.name }) : t('newTitle')}
      closeLabel={tc('close')}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              onClose(false);
            }}
          >
            {tc('cancel')}
          </Button>
          <Button
            variant="primary"
            loading={saving}
            loadingLabel={tc('save')}
            disabled={!name.trim() || !matchingRuleId}
            onClick={() => void save()}
          >
            {tc('save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? (
          <Banner tone="danger" role="alert">
            {error}
          </Banner>
        ) : null}
        <FormField label={t('name')} required>
          <Input
            value={name}
            maxLength={80}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </FormField>
        <FormField label={t('object')}>
          <Select
            disabled={rule !== null}
            options={OBJECTS.map((o) => ({ value: o, label: to(`objects.${o}`) }))}
            value={object}
            onValueChange={(v) => {
              setObject(v as DedupeObject);
              setMatchingRuleId('');
            }}
          />
        </FormField>
        <FormField
          label={t('matchingRule')}
          required
          helper={rules.length ? undefined : t('noMatching')}
        >
          <Select
            placeholder={t('chooseRule')}
            options={rules.map((r) => ({ value: r.id, label: r.name }))}
            {...(matchingRuleId ? { value: matchingRuleId } : {})}
            onValueChange={setMatchingRuleId}
          />
        </FormField>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-label text-fg">{t('action')}</legend>
          <RadioGroup
            value={action}
            onValueChange={(v) => {
              setAction(v as 'BLOCK' | 'ALERT');
            }}
          >
            <Radio value="ALERT" label={t('alertLong')} />
            <Radio value="BLOCK" label={t('blockLong')} />
          </RadioGroup>
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-label text-fg">{t('when')}</legend>
          <Checkbox
            label={t('onCreate')}
            checked={onCreate}
            onCheckedChange={(v) => {
              setOnCreate(v === true);
            }}
          />
          <Checkbox
            label={t('onEdit')}
            checked={onEdit}
            onCheckedChange={(v) => {
              setOnEdit(v === true);
            }}
          />
        </fieldset>
        {action === 'BLOCK' ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-label text-fg">{t('bypass')}</legend>
            {(profiles.data?.items ?? []).map((p) => (
              <Checkbox
                key={p.id}
                label={p.name}
                checked={bypass.includes(p.id)}
                onCheckedChange={(v) => {
                  setBypass((b) => (v === true ? [...b, p.id] : b.filter((x) => x !== p.id)));
                }}
              />
            ))}
          </fieldset>
        ) : null}
        <Checkbox
          label={t('active')}
          checked={active}
          onCheckedChange={(v) => {
            setActive(v === true);
          }}
        />
      </div>
    </Dialog>
  );
}

function Jobs() {
  const t = useTranslations('setup.duplicates.jobs');
  const to = useTranslations('setup.duplicates');
  const tc = useTranslations('common.actions');
  const format = useFormatter();
  const toast = useToast();
  const problem = useSetupProblem();
  const canChange = useHasPermission('customize_application');
  const { data, failure, reload } = useResource<{ items: Job[] }>('/v1/duplicate-jobs');
  const matching = useResource<{ items: MatchingRule[] }>('/v1/setup/matching-rules');
  const [open, setOpen] = useState(false);
  const [ruleId, setRuleId] = useState('');
  const [schedule, setSchedule] = useState<'none' | 'daily' | 'weekly'>('none');
  const [error, setError] = useState('');
  if (!data) return <ResourceState failure={failure} loading />;

  const start = async () => {
    setError('');
    const r = await cellApi('POST', '/v1/duplicate-jobs', {
      matchingRuleId: ruleId,
      schedule: schedule === 'none' ? null : schedule,
    });
    if (!r.ok) {
      setError(problem(r));
      return;
    }
    toast({ tone: 'success', title: t('started') });
    setOpen(false);
    reload();
  };
  const when = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  return (
    <section aria-labelledby="jobs-title" className="grid gap-3 pt-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="jobs-title" className="text-title-3 text-fg">
          {t('title')}
        </h2>
        {canChange ? (
          <Button
            icon={<Plus />}
            onClick={() => {
              setOpen(true);
            }}
          >
            {t('scan')}
          </Button>
        ) : null}
      </div>
      <p className="text-body-sm text-fg-secondary">{t('hint')}</p>
      {data.items.length === 0 ? (
        <p className="text-body-sm text-fg-secondary">{t('none')}</p>
      ) : (
        <table className="w-full border-collapse text-body-sm">
          <thead>
            <tr className="border-b border-line text-caption text-fg-secondary">
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('rule')}
              </th>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('object')}
              </th>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('status')}
              </th>
              <th scope="col" className="px-3 py-2 text-end font-medium">
                {t('scanned')}
              </th>
              <th scope="col" className="px-3 py-2 text-end font-medium">
                {t('found')}
              </th>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('schedule')}
              </th>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('finished')}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((j) => (
              <tr key={j.id} className="border-b border-line-subtle">
                <td className="px-3 py-2 text-fg">{j.matchingRule.name}</td>
                <td className="px-3 py-2 text-fg">{to(`objects.${j.object}`)}</td>
                <td className="px-3 py-2">
                  <StatusChip
                    tone={
                      j.status === 'SUCCEEDED'
                        ? 'success'
                        : j.status === 'FAILED'
                          ? 'danger'
                          : 'info'
                    }
                  >
                    {t(`statuses.${j.status.toLowerCase() as 'queued'}`)}
                  </StatusChip>
                </td>
                <td className="px-3 py-2 text-end tabular">{j.scanned.toLocaleString()}</td>
                <td className="px-3 py-2 text-end tabular">{j.found.toLocaleString()}</td>
                <td className="px-3 py-2 text-fg">{j.schedule ? t(j.schedule) : t('once')}</td>
                <td className="px-3 py-2 text-fg-secondary">{when(j.finishedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t('scanTitle')}
        closeLabel={tc('close')}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setOpen(false);
              }}
            >
              {tc('cancel')}
            </Button>
            <Button variant="primary" disabled={!ruleId} onClick={() => void start()}>
              {t('start')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <FormField label={t('rule')} required>
            <Select
              placeholder={t('chooseRule')}
              options={(matching.data?.items ?? []).map((r) => ({
                value: r.id,
                label: `${r.name} · ${to(`objects.${r.object}`)}`,
              }))}
              {...(ruleId ? { value: ruleId } : {})}
              onValueChange={setRuleId}
            />
          </FormField>
          <FormField label={t('schedule')}>
            <Select
              options={[
                { value: 'none', label: t('once') },
                { value: 'daily', label: t('daily') },
                { value: 'weekly', label: t('weekly') },
              ]}
              value={schedule}
              onValueChange={(v) => {
                setSchedule(v as 'none');
              }}
            />
          </FormField>
        </div>
      </Dialog>
    </section>
  );
}
