'use client';

import type { OrgWideDefaultDto, PublicGroupDto, SharingRuleDto } from '@sm/contracts';
import { camelCase, standardObject, STANDARD_OBJECTS } from '@sm/metadata';
import {
  Banner,
  Button,
  Checkbox,
  Combobox,
  Dialog,
  FormField,
  IconButton,
  Input,
  Radio,
  RadioGroup,
  Select,
  StatusChip,
  useToast,
} from '@sm/ui';
import { Plus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import type { z } from 'zod';

import { cellApi } from '../../../lib/cell-api';
import { DeleteDialog, ResourceState, useResource } from '../common';
import { useSetupOptions } from '../pickers';
import { SetupHeader, useHasPermission } from '../setup-shell';
import { useSetupProblem } from '../use-problem';

type Owd = z.infer<typeof OrgWideDefaultDto>;
type Rule = z.infer<typeof SharingRuleDto>;
type Group = z.infer<typeof PublicGroupDto>;
type Model = Owd['sharingModel'];
type PrincipalType = 'GROUP' | 'ORG_UNIT' | 'ORG_UNIT_AND_SUBORDINATES';
type Op = 'eq' | 'ne' | 'contains' | 'starts_with' | 'is_null' | 'is_not_null';
interface Condition {
  field: string;
  op: Op;
  value: string;
}

const MODEL_KEY = {
  PRIVATE: 'private',
  PUBLIC_READ: 'publicRead',
  PUBLIC_READ_WRITE: 'publicReadWrite',
  CONTROLLED_BY_PARENT: 'controlledByParent',
} as const;
const PRINCIPAL_KEY = {
  GROUP: 'group',
  ORG_UNIT: 'orgUnit',
  ORG_UNIT_AND_SUBORDINATES: 'orgUnitAndSubordinates',
} as const;
const OP_KEY = {
  eq: 'eq',
  ne: 'ne',
  contains: 'contains',
  starts_with: 'startsWith',
  is_null: 'isNull',
  is_not_null: 'isNotNull',
} as const;
const NO_VALUE: readonly Op[] = ['is_null', 'is_not_null'];
/** Rules add nothing under these defaults, so the API refuses them (§6.3). */
const NO_RULES: readonly Model[] = ['PUBLIC_READ_WRITE', 'CONTROLLED_BY_PARENT'];
const TEXT_TYPES = new Set(['text', 'email', 'phone', 'url', 'picklist', 'textarea']);

/** The criteria the editor understands: one condition, or an AND of plain conditions. */
function conditionsOf(criteria: unknown): Condition[] | null {
  const plain = (node: unknown): Condition | null => {
    if (typeof node !== 'object' || node === null) return null;
    const n = node as { field?: unknown; op?: unknown; value?: unknown };
    if (typeof n.field !== 'string' || typeof n.op !== 'string' || !(n.op in OP_KEY)) return null;
    if (n.value !== undefined && typeof n.value !== 'string') return null;
    return { field: n.field, op: n.op as Op, value: n.value ?? '' };
  };
  if (criteria === null || criteria === undefined) return [];
  const single = plain(criteria);
  if (single) return [single];
  const and = (criteria as { and?: unknown }).and;
  if (!Array.isArray(and)) return null;
  const all = and.map(plain);
  return all.every((c): c is Condition => c !== null) ? all : null;
}

function criteriaOf(conditions: Condition[]): unknown {
  const nodes = conditions.map((c) => (NO_VALUE.includes(c.op) ? { field: c.field, op: c.op } : c));
  return nodes.length === 1 ? nodes[0] : { and: nodes };
}

function useObjectLabel() {
  const t = useTranslations();
  return (apiName: string) => t(`objects.${camelCase(apiName)}.plural` as Parameters<typeof t>[0]);
}

/** Setup → Sharing settings (§6.3): org-wide defaults and sharing rules (ADR-0007). */
export function SharingSettings() {
  const t = useTranslations('setup.sharing');
  const canCustomize = useHasPermission('customize_application');
  const owd = useResource<{ items: Owd[] }>('/v1/sharing/owd');
  const rules = useResource<{ items: Rule[] }>('/v1/sharing/rules');
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);

  // Poll while a recalculation is queued or running, for about two minutes at most.
  const pending = rules.data?.items.some(
    (r) => r.lastRun?.status === 'QUEUED' || r.lastRun?.status === 'RUNNING',
  );
  const { reload } = rules;
  useEffect(() => {
    if (!pending) return;
    let polls = 0;
    const timer = setInterval(() => {
      polls += 1;
      if (polls > 60) clearInterval(timer);
      else reload();
    }, 2000);
    return () => {
      clearInterval(timer);
    };
  }, [pending, reload]);

  if (!owd.data || !rules.data)
    return (
      <ResourceState
        failure={owd.failure ?? rules.failure}
        loading={!owd.failure && !rules.failure}
      />
    );
  return (
    <>
      <SetupHeader title={t('title')} description={t('description')} />
      <div className="flex max-w-5xl flex-col gap-8 p-[var(--page-padding)]">
        <OwdTable items={owd.data.items} canEdit={canCustomize} onSaved={owd.reload} />
        <section className="flex flex-col gap-3" aria-labelledby="rules-heading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="rules-heading" className="text-title-3 text-fg">
                {t('rulesTitle')}
              </h2>
              <p className="text-body-sm text-fg-secondary">{t('rulesHelp')}</p>
            </div>
            {canCustomize ? (
              <Button
                variant="primary"
                icon={<Plus />}
                onClick={() => {
                  setEditing('new');
                }}
              >
                {t('newRule')}
              </Button>
            ) : null}
          </div>
          <Banner tone="info">{t('convergence')}</Banner>
          <RulesTable
            rules={rules.data.items}
            onOpen={(r) => {
              setEditing(r);
            }}
          />
        </section>
      </div>
      {editing ? (
        <RuleDialog
          rule={editing === 'new' ? null : editing}
          owd={owd.data.items}
          readOnly={!canCustomize}
          onClose={(changed) => {
            setEditing(null);
            if (changed) rules.reload();
          }}
        />
      ) : null}
    </>
  );
}

function OwdTable({
  items,
  canEdit,
  onSaved,
}: {
  items: Owd[];
  canEdit: boolean;
  onSaved: () => void;
}) {
  const t = useTranslations('setup.sharing');
  const toast = useToast();
  const problem = useSetupProblem();
  const label = useObjectLabel();
  const change = async (object: string, sharingModel: Model) => {
    const result = await cellApi<Owd>('PUT', `/v1/sharing/owd/${object}`, { sharingModel });
    if (!result.ok) {
      toast({ tone: 'error', title: problem(result) });
      return;
    }
    toast({
      tone: 'success',
      title: t('owdSaved', {
        object: label(object),
        model: t(`models.${MODEL_KEY[sharingModel]}`),
      }),
    });
    onSaved();
  };
  return (
    <section className="flex flex-col gap-3" aria-labelledby="owd-heading">
      <div>
        <h2 id="owd-heading" className="text-title-3 text-fg">
          {t('owdTitle')}
        </h2>
        <p className="text-body-sm text-fg-secondary">{t('owdHelp')}</p>
      </div>
      <table className="w-full max-w-2xl border-collapse text-body-sm">
        <thead>
          <tr className="border-b border-line text-caption text-fg-secondary">
            <th scope="col" className="px-3 py-2 text-start font-medium">
              {t('object')}
            </th>
            <th scope="col" className="px-3 py-2 text-start font-medium">
              {t('defaultAccess')}
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((o) => (
            <tr key={o.object} className="border-b border-line-subtle">
              <th scope="row" className="px-3 py-1.5 text-start font-normal">
                {label(o.object)}
              </th>
              <td className="px-3 py-1.5">
                <Select
                  aria-label={`${label(o.object)}: ${t('defaultAccess')}`}
                  value={o.sharingModel}
                  disabled={!canEdit}
                  onValueChange={(v) => void change(o.object, v as Model)}
                  options={o.allowedModels.map((m) => ({
                    value: m,
                    label: t(`models.${MODEL_KEY[m]}`),
                  }))}
                  className="w-56"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function RunStatus({ run }: { run: Rule['lastRun'] }) {
  const t = useTranslations('setup.sharing.run');
  if (!run) return <StatusChip>{t('never')}</StatusChip>;
  switch (run.status) {
    case 'QUEUED':
      return (
        <StatusChip tone="info" dot>
          {t('queued')}
        </StatusChip>
      );
    case 'RUNNING':
      return (
        <StatusChip tone="info" dot>
          {run.total === null
            ? t('runningUnknown')
            : t('running', { done: run.done, total: run.total })}
        </StatusChip>
      );
    case 'SUCCEEDED':
      return (
        <StatusChip tone="success" dot>
          {t('succeeded')}
        </StatusChip>
      );
    case 'FAILED':
      return (
        <StatusChip tone="danger" dot>
          {t('failed')}
        </StatusChip>
      );
  }
}

function RulesTable({ rules, onOpen }: { rules: Rule[]; onOpen: (rule: Rule) => void }) {
  const t = useTranslations('setup.sharing');
  const tr = useTranslations('setup.sharing.rule');
  const label = useObjectLabel();
  if (rules.length === 0) return <p className="text-body-sm text-fg-secondary">{t('noRules')}</p>;
  return (
    <table className="w-full border-collapse text-body-sm">
      <thead>
        <tr className="border-b border-line text-caption text-fg-secondary">
          <th scope="col" className="px-3 py-2 text-start font-medium">
            {tr('name')}
          </th>
          <th scope="col" className="px-3 py-2 text-start font-medium">
            {tr('object')}
          </th>
          <th scope="col" className="px-3 py-2 text-start font-medium">
            {tr('target')}
          </th>
          <th scope="col" className="px-3 py-2 text-start font-medium">
            {tr('access')}
          </th>
          <th scope="col" className="px-3 py-2 text-start font-medium">
            <span className="sr-only">{tr('active')}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rules.map((r) => (
          <tr key={r.id} className="border-b border-line-subtle hover:bg-hover">
            <td className="px-3 py-2">
              <Button
                variant="link"
                onClick={() => {
                  onOpen(r);
                }}
              >
                {r.name}
              </Button>
            </td>
            <td className="px-3 py-2 text-fg-secondary">{label(r.object)}</td>
            <td className="px-3 py-2 text-fg-secondary">{r.target.name}</td>
            <td className="px-3 py-2 text-fg-secondary">{tr(r.access)}</td>
            <td className="px-3 py-2">
              {r.active ? <RunStatus run={r.lastRun} /> : <StatusChip>{tr('inactive')}</StatusChip>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Pick a group or org unit for a rule's source or target. */
function PrincipalField({
  label,
  type,
  id,
  onChange,
  readOnly,
}: {
  label: string;
  type: PrincipalType;
  id: string;
  onChange: (next: { type: PrincipalType; id: string }) => void;
  readOnly: boolean;
}) {
  const t = useTranslations('setup.sharing.rule.principal');
  const common = useTranslations('common');
  const { units } = useSetupOptions();
  const groups = useResource<{ items: Group[] }>('/v1/groups');
  const options =
    type === 'GROUP'
      ? (groups.data?.items ?? []).map((g) => ({ value: g.id, label: g.name }))
      : (units ?? []);
  return (
    <FormField label={label} required disabled={readOnly}>
      <div className="flex flex-wrap gap-2">
        <Select
          aria-label={label}
          value={type}
          disabled={readOnly}
          onValueChange={(v) => {
            onChange({ type: v as PrincipalType, id: '' });
          }}
          options={(Object.keys(PRINCIPAL_KEY) as PrincipalType[]).map((k) => ({
            value: k,
            label: t(PRINCIPAL_KEY[k]),
          }))}
          className="w-52"
        />
        <div className="min-w-56 flex-1">
          <Combobox
            options={options}
            value={id}
            disabled={readOnly}
            onValueChange={(v) => {
              onChange({ type, id: v });
            }}
            placeholder={label}
            searchPlaceholder={common('search.placeholder')}
            emptyText={common('search.noResults')}
          />
        </div>
      </div>
    </FormField>
  );
}

interface RuleDraft {
  object: string;
  name: string;
  kind: 'OWNER' | 'CRITERIA';
  source: { type: PrincipalType; id: string };
  conditions: Condition[] | null;
  target: { type: PrincipalType; id: string };
  access: 'read' | 'edit';
  active: boolean;
}

function draftOf(rule: Rule | null, owd: Owd[]): RuleDraft {
  const firstUsable = owd.find((o) => !NO_RULES.includes(o.sharingModel))?.object ?? 'account';
  const principal = (p: Rule['target'] | null) =>
    p && p.type !== 'USER' && p.type !== 'QUEUE'
      ? { type: p.type, id: p.id }
      : { type: 'GROUP' as const, id: '' };
  return {
    object: rule?.object ?? firstUsable,
    name: rule?.name ?? '',
    kind: rule?.kind ?? 'OWNER',
    source: principal(rule?.source ?? null),
    conditions: rule ? conditionsOf(rule.criteria) : [],
    target: principal(rule?.target ?? null),
    access: rule?.access ?? 'read',
    active: rule?.active ?? true,
  };
}

function RuleDialog({
  rule,
  owd,
  readOnly,
  onClose,
}: {
  rule: Rule | null;
  owd: Owd[];
  readOnly: boolean;
  onClose: (changed: boolean) => void;
}) {
  const t = useTranslations('setup.sharing.rule');
  const ts = useTranslations('setup.sharing');
  const tc = useTranslations('setup.common');
  const common = useTranslations('common');
  const tAll = useTranslations();
  const toast = useToast();
  const problem = useSetupProblem();
  const label = useObjectLabel();
  const [draft, setDraft] = useState<RuleDraft>(() => draftOf(rule, owd));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const initial = JSON.stringify(draftOf(rule, owd));
  const dirty = JSON.stringify(draft) !== initial;
  const model = owd.find((o) => o.object === draft.object)?.sharingModel ?? 'PRIVATE';
  const fields = (standardObject(draft.object)?.fields ?? []).filter(
    (f) => !f.system && TEXT_TYPES.has(f.type),
  );
  const set = (patch: Partial<RuleDraft>) => {
    setDraft({ ...draft, ...patch });
  };

  const save = async () => {
    if (!draft.name.trim() || !draft.target.id || (draft.kind === 'OWNER' && !draft.source.id)) {
      setError(tc('invalid'));
      return;
    }
    setPending(true);
    const criteria =
      draft.kind === 'CRITERIA' && draft.conditions ? criteriaOf(draft.conditions) : undefined;
    // On an edit, only what changed is sent: a rename alone must not recalculate the rule.
    const before = draftOf(rule, owd);
    const changed = (key: 'source' | 'target' | 'conditions') =>
      !rule || JSON.stringify(before[key]) !== JSON.stringify(draft[key]);
    const body = {
      name: draft.name.trim(),
      access: draft.access,
      active: draft.active,
      ...(changed('target') ? { target: draft.target } : {}),
      ...(draft.kind === 'OWNER' && changed('source') ? { source: draft.source } : {}),
      ...(criteria !== undefined && changed('conditions') ? { criteria } : {}),
    };
    const result = rule
      ? await cellApi<Rule>('PATCH', `/v1/sharing/rules/${rule.id}`, {
          ...body,
          version: rule.version,
        })
      : await cellApi<Rule>('POST', '/v1/sharing/rules', {
          ...body,
          object: draft.object,
          kind: draft.kind,
        });
    setPending(false);
    if (!result.ok) {
      setError(problem(result, { conflict: tc('nameTaken') }));
      return;
    }
    toast({ tone: 'success', title: t('saved') });
    onClose(true);
  };

  const conditions = draft.conditions;
  return (
    <>
      <Dialog
        open
        size="lg"
        onOpenChange={(open) => {
          if (!open) onClose(false);
        }}
        title={rule ? rule.name : ts('newRule')}
        description={ts('convergence')}
        closeLabel={common('actions.close')}
        dirty={dirty}
        discardCopy={{
          title: tc('discardTitle'),
          body: tc('discardBody'),
          confirm: tc('discard'),
          cancel: tc('keepEditing'),
        }}
        footer={
          readOnly ? (
            <Button
              onClick={() => {
                onClose(false);
              }}
            >
              {common('actions.close')}
            </Button>
          ) : (
            <>
              {rule ? (
                <Button
                  variant="danger"
                  className="me-auto"
                  onClick={() => {
                    setDeleting(true);
                  }}
                >
                  {tc('delete')}
                </Button>
              ) : null}
              <Button
                onClick={() => {
                  onClose(false);
                }}
              >
                {common('actions.cancel')}
              </Button>
              <Button
                variant="primary"
                disabled={pending || !dirty || NO_RULES.includes(model)}
                onClick={() => void save()}
              >
                {tc('saveChanges')}
              </Button>
            </>
          )
        }
      >
        <div className="flex flex-col gap-4">
          {error ? (
            <p role="alert" className="text-body-sm text-danger">
              {error}
            </p>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('object')} required disabled={readOnly || Boolean(rule)}>
              <Select
                aria-label={t('object')}
                value={draft.object}
                disabled={readOnly || Boolean(rule)}
                onValueChange={(object) => {
                  set({ object, conditions: [] });
                }}
                options={STANDARD_OBJECTS.map((o) => ({
                  value: o.apiName,
                  label: label(o.apiName),
                }))}
              />
            </FormField>
            <FormField label={t('name')} required disabled={readOnly}>
              <Input
                value={draft.name}
                onChange={(e) => {
                  set({ name: e.target.value });
                }}
              />
            </FormField>
          </div>
          {NO_RULES.includes(model) ? (
            <Banner tone="warning">
              {t('noRulesObject', { model: ts(`models.${MODEL_KEY[model]}`) })}
            </Banner>
          ) : null}
          <FormField label={t('kind')} disabled={readOnly || Boolean(rule)}>
            <RadioGroup
              value={draft.kind}
              disabled={readOnly || Boolean(rule)}
              onValueChange={(v) => {
                set({ kind: v as RuleDraft['kind'] });
              }}
              className="flex gap-6"
            >
              <Radio value="OWNER" label={t('owner')} />
              <Radio value="CRITERIA" label={t('criteria')} />
            </RadioGroup>
          </FormField>
          {draft.kind === 'OWNER' ? (
            <PrincipalField
              label={t('source')}
              type={draft.source.type}
              id={draft.source.id}
              readOnly={readOnly}
              onChange={(source) => {
                set({ source });
              }}
            />
          ) : conditions === null ? (
            <Banner tone="info">{t('advanced')}</Banner>
          ) : (
            <fieldset className="flex flex-col gap-2" disabled={readOnly}>
              <legend className="pb-1 text-label text-fg">{t('criteria')}</legend>
              <p className="text-body-sm text-fg-secondary">{t('allConditions')}</p>
              {conditions.map((c, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <Select
                    aria-label={t('field')}
                    value={c.field}
                    onValueChange={(field) => {
                      set({
                        conditions: conditions.map((x, j) => (j === i ? { ...x, field } : x)),
                      });
                    }}
                    options={fields.map((f) => ({
                      value: f.apiName,
                      label: tAll(f.labelKey as Parameters<typeof tAll>[0]),
                    }))}
                    className="w-48"
                  />
                  <Select
                    aria-label={t('operator')}
                    value={c.op}
                    onValueChange={(op) => {
                      set({
                        conditions: conditions.map((x, j) =>
                          j === i ? { ...x, op: op as Op } : x,
                        ),
                      });
                    }}
                    options={(Object.keys(OP_KEY) as Op[]).map((op) => ({
                      value: op,
                      label: t(`ops.${OP_KEY[op]}`),
                    }))}
                    className="w-44"
                  />
                  {NO_VALUE.includes(c.op) ? null : (
                    <Input
                      aria-label={t('value')}
                      value={c.value}
                      onChange={(e) => {
                        set({
                          conditions: conditions.map((x, j) =>
                            j === i ? { ...x, value: e.target.value } : x,
                          ),
                        });
                      }}
                      className="w-48"
                    />
                  )}
                  <IconButton
                    label={t('removeCondition')}
                    size="sm"
                    onClick={() => {
                      set({ conditions: conditions.filter((_, j) => j !== i) });
                    }}
                  >
                    <X />
                  </IconButton>
                </div>
              ))}
              <Button
                size="sm"
                icon={<Plus />}
                className="self-start"
                disabled={fields.length === 0}
                onClick={() => {
                  set({
                    conditions: [
                      ...conditions,
                      { field: fields[0]?.apiName ?? '', op: 'eq', value: '' },
                    ],
                  });
                }}
              >
                {t('addCondition')}
              </Button>
            </fieldset>
          )}
          <PrincipalField
            label={t('target')}
            type={draft.target.type}
            id={draft.target.id}
            readOnly={readOnly}
            onChange={(target) => {
              set({ target });
            }}
          />
          <FormField label={t('access')} disabled={readOnly}>
            <RadioGroup
              value={draft.access}
              disabled={readOnly}
              onValueChange={(v) => {
                set({ access: v as RuleDraft['access'] });
              }}
              className="flex gap-6"
            >
              <Radio value="read" label={t('read')} />
              <Radio value="edit" label={t('edit')} />
            </RadioGroup>
          </FormField>
          <Checkbox
            label={t('active')}
            checked={draft.active}
            disabled={readOnly}
            onCheckedChange={(c) => {
              set({ active: c === true });
            }}
          />
        </div>
      </Dialog>
      {rule ? (
        <DeleteDialog
          open={deleting}
          onOpenChange={setDeleting}
          name={rule.name}
          path={`/v1/sharing/rules/${rule.id}`}
          inUse={tc('inUse')}
          onDeleted={() => {
            toast({ tone: 'info', title: t('deleted') });
            onClose(true);
          }}
        />
      ) : null}
    </>
  );
}
