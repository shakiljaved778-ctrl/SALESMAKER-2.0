'use client';

import type { ObjectSummaryDto, PageLayoutDto, ProfileSummary } from '@sm/contracts';
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
  Textarea,
  useToast,
} from '@sm/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import type { z } from 'zod';

import { cellApi } from '../../../lib/cell-api';
import { useSetupProblem } from '../use-problem';
import {
  CUSTOM_FIELD_TYPES,
  HAS_DIGITS,
  HAS_LENGTH,
  HAS_VALUES,
  TYPE_LABEL,
  toApiName,
  type CustomFieldType,
} from './types';

type Profile = z.infer<typeof ProfileSummary>;
type Layout = z.infer<typeof PageLayoutDto>;
type ObjectSummary = z.infer<typeof ObjectSummaryDto>;
type Step = 'type' | 'details' | 'access' | 'layouts';
const STEPS: Step[] = ['type', 'details', 'access', 'layouts'];
const STEP_LABEL = {
  type: 'wizard.stepType',
  details: 'wizard.stepDetails',
  access: 'wizard.stepAccess',
  layouts: 'wizard.stepLayouts',
} as const;

/** Sensible starting sizes per type (§5.3); the admin can change them. */
const DEFAULT_LENGTH: Record<string, number> = { text: 255, textarea: 1000, long_text: 32_768 };
const DEFAULT_DIGITS: Record<string, [number, number]> = {
  number: [18, 0],
  currency: [18, 2],
  percent: [5, 2],
};

interface Access {
  read: boolean;
  edit: boolean;
}

/**
 * New custom field (§5.2): type → details → field-level security per profile → page layouts.
 * The System Administrator profile always gets access (the API grants it).
 */
export function NewFieldWizard({
  object,
  onClose,
}: {
  object: string;
  onClose: (created: boolean) => void;
}) {
  const t = useTranslations('setup.objects');
  const tc = useTranslations('common.actions');
  const ts = useTranslations('setup.common');
  const toast = useToast();
  const problem = useSetupProblem();
  const [step, setStep] = useState<Step>('type');
  const [type, setType] = useState<CustomFieldType>('text');
  const [label, setLabel] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [length, setLength] = useState('');
  const [precision, setPrecision] = useState('');
  const [scale, setScale] = useState('');
  const [target, setTarget] = useState('');
  const [values, setValues] = useState('');
  const [required, setRequired] = useState(false);
  const [trackHistory, setTrackHistory] = useState(false);
  const [helpText, setHelpText] = useState('');
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [access, setAccess] = useState<Record<string, Access>>({});
  const [layouts, setLayouts] = useState<Layout[]>([]);
  const [onLayouts, setOnLayouts] = useState<Set<string>>(new Set());
  const [objects, setObjects] = useState<ObjectSummary[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void cellApi<{ items: Profile[] }>('GET', '/v1/profiles').then((r) => {
      if (!r.ok) return;
      setProfiles(r.data.items);
      // Every profile reads and edits a new field unless the admin says otherwise.
      setAccess(Object.fromEntries(r.data.items.map((p) => [p.id, { read: true, edit: true }])));
    });
    void cellApi<{ items: Layout[] }>('GET', `/v1/setup/objects/${object}/layouts`).then((r) => {
      if (!r.ok) return;
      setLayouts(r.data.items);
      setOnLayouts(new Set(r.data.items.map((l) => l.id)));
    });
    void cellApi<{ items: ObjectSummary[] }>('GET', '/v1/objects').then((r) => {
      if (r.ok) setObjects(r.data.items);
    });
  }, [object]);

  const chooseType = (next: CustomFieldType) => {
    setType(next);
    setLength(DEFAULT_LENGTH[next] ? String(DEFAULT_LENGTH[next]) : '');
    const digits = DEFAULT_DIGITS[next];
    setPrecision(digits ? String(digits[0]) : '');
    setScale(digits ? String(digits[1]) : '');
  };

  const picklist = values
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);
  const detailsValid =
    label.trim() !== '' &&
    /^[a-z][a-z0-9_]{0,34}$/.test(name) &&
    !name.includes('__') &&
    (!HAS_VALUES.has(type) || picklist.length > 0) &&
    (type !== 'lookup' || target !== '');

  const create = async () => {
    setSaving(true);
    setError('');
    const body = {
      name,
      label: label.trim(),
      type,
      required,
      trackHistory,
      ...(helpText.trim() ? { helpText: helpText.trim() } : {}),
      ...(HAS_LENGTH.has(type) && length ? { length: Number(length) } : {}),
      ...(HAS_DIGITS.has(type) && precision ? { precision: Number(precision) } : {}),
      ...(HAS_DIGITS.has(type) && scale ? { scale: Number(scale) } : {}),
      ...(type === 'lookup' ? { referenceTo: target } : {}),
      ...(HAS_VALUES.has(type)
        ? {
            picklistValues: picklist.map((v, i) => ({
              apiValue: toApiName(v, 80) || `value_${String(i + 1)}`,
              label: v,
            })),
          }
        : {}),
      access: profiles
        .filter((p) => access[p.id]?.read)
        .map((p) => ({
          permissionSetId: p.permissionSetId,
          read: true,
          edit: Boolean(access[p.id]?.edit),
        })),
    };
    const r = await cellApi<{ apiName: string }>(
      'POST',
      `/v1/setup/objects/${object}/fields`,
      body,
    );
    if (!r.ok) {
      setSaving(false);
      setError(problem(r, { conflict: t('wizard.nameTaken') }));
      setStep('details');
      return;
    }
    // Place the field at the end of each chosen layout's first section.
    let placed = true;
    for (const layout of layouts.filter((l) => onLayouts.has(l.id))) {
      const [first, ...rest] = layout.sections;
      if (!first) continue;
      const sections = [
        { ...first, fields: [...first.fields, { field: r.data.apiName }] },
        ...rest,
      ];
      const u = await cellApi('PATCH', `/v1/setup/objects/${object}/layouts/${layout.id}`, {
        version: layout.version,
        sections,
      });
      placed &&= u.ok;
    }
    setSaving(false);
    toast({
      tone: placed ? 'success' : 'error',
      title: placed ? ts('created', { name: label.trim() }) : t('wizard.layoutsFailed'),
    });
    onClose(true);
  };

  const at = STEPS.indexOf(step);
  const canNext = step === 'type' || (step === 'details' ? detailsValid : true);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose(false);
      }}
      size="lg"
      title={t('newField')}
      description={t('wizard.progress', {
        step: at + 1,
        total: STEPS.length,
        name: t(STEP_LABEL[step]),
      })}
      closeLabel={tc('close')}
      dirty={label !== ''}
      discardCopy={{
        title: ts('discardTitle'),
        body: ts('discardBody'),
        confirm: ts('discard'),
        cancel: ts('keepEditing'),
      }}
      footer={
        <>
          {at > 0 ? (
            <Button
              onClick={() => {
                setStep(STEPS[at - 1] ?? 'type');
              }}
            >
              {tc('back')}
            </Button>
          ) : null}
          {step === 'layouts' ? (
            <Button variant="primary" loading={saving} onClick={() => void create()}>
              {t('wizard.create')}
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={!canNext}
              onClick={() => {
                setStep(STEPS[at + 1] ?? 'layouts');
              }}
            >
              {tc('continue')}
            </Button>
          )}
        </>
      }
    >
      <div className="grid gap-4">
        {error ? <Banner tone="danger">{error}</Banner> : null}

        {step === 'type' ? (
          <fieldset>
            <legend className="mb-2 text-label text-fg-secondary">{t('type')}</legend>
            <RadioGroup
              value={type}
              onValueChange={(v) => {
                chooseType(v as CustomFieldType);
              }}
              className="grid grid-cols-2 gap-2 sm:grid-cols-3"
            >
              {CUSTOM_FIELD_TYPES.map((ft) => (
                <Radio key={ft} value={ft} label={t(TYPE_LABEL[ft])} />
              ))}
            </RadioGroup>
          </fieldset>
        ) : null}

        {step === 'details' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('label')} required>
              <Input
                value={label}
                maxLength={80}
                onChange={(e) => {
                  setLabel(e.target.value);
                  if (!nameTouched) setName(toApiName(e.target.value));
                }}
              />
            </FormField>
            <FormField
              label={t('apiName')}
              required
              helper={t('wizard.apiNameHelp', { name: name || 'name' })}
            >
              <Input
                value={name}
                dir="ltr"
                className="font-mono"
                suffix={<span className="font-mono text-fg-tertiary">__c</span>}
                onChange={(e) => {
                  setNameTouched(true);
                  setName(e.target.value);
                }}
              />
            </FormField>
            {HAS_LENGTH.has(type) ? (
              <FormField label={t('wizard.length')}>
                <Input
                  type="number"
                  inputMode="numeric"
                  value={length}
                  onChange={(e) => {
                    setLength(e.target.value);
                  }}
                />
              </FormField>
            ) : null}
            {HAS_DIGITS.has(type) ? (
              <>
                <FormField label={t('wizard.precision')}>
                  <Input
                    type="number"
                    inputMode="numeric"
                    value={precision}
                    onChange={(e) => {
                      setPrecision(e.target.value);
                    }}
                  />
                </FormField>
                {type === 'currency' ? null : (
                  <FormField label={t('wizard.scale')}>
                    <Input
                      type="number"
                      inputMode="numeric"
                      value={scale}
                      onChange={(e) => {
                        setScale(e.target.value);
                      }}
                    />
                  </FormField>
                )}
              </>
            ) : null}
            {type === 'lookup' ? (
              <FormField label={t('wizard.target')} required>
                <Select
                  placeholder={t('wizard.targetPlaceholder')}
                  options={objects.map((o) => ({ value: o.name, label: o.label }))}
                  {...(target ? { value: target } : {})}
                  onValueChange={setTarget}
                />
              </FormField>
            ) : null}
            {HAS_VALUES.has(type) ? (
              <div className="sm:col-span-2">
                <FormField label={t('wizard.values')} required helper={t('wizard.valuesHelp')}>
                  <Textarea
                    rows={5}
                    value={values}
                    onChange={(e) => {
                      setValues(e.target.value);
                    }}
                  />
                </FormField>
              </div>
            ) : null}
            <div className="sm:col-span-2">
              <FormField label={t('wizard.helpText')}>
                <Input
                  value={helpText}
                  maxLength={1000}
                  onChange={(e) => {
                    setHelpText(e.target.value);
                  }}
                />
              </FormField>
            </div>
            <Checkbox
              label={t('wizard.required')}
              checked={required}
              onCheckedChange={(c) => {
                setRequired(c === true);
              }}
            />
            <Checkbox
              label={t('wizard.trackHistory')}
              checked={trackHistory}
              onCheckedChange={(c) => {
                setTrackHistory(c === true);
              }}
            />
          </div>
        ) : null}

        {step === 'access' ? (
          <div className="grid gap-2">
            <p className="text-body-sm text-fg-secondary">{t('wizard.accessHelp')}</p>
            <table className="w-full border-collapse text-body-sm">
              <thead>
                <tr className="border-b border-line text-caption text-fg-secondary">
                  <th scope="col" className="px-3 py-2 text-start font-medium">
                    {t('wizard.profile')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-start font-medium">
                    {t('wizard.read')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-start font-medium">
                    {t('wizard.edit')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((p) => {
                  const admin = p.systemKey === 'system_administrator';
                  const a = admin
                    ? { read: true, edit: true }
                    : (access[p.id] ?? { read: false, edit: false });
                  const set = (next: Access) => {
                    setAccess((prev) => ({ ...prev, [p.id]: next }));
                  };
                  return (
                    <tr key={p.id} className="border-b border-line-subtle">
                      <th scope="row" className="px-3 py-2 text-start font-normal text-fg">
                        {p.name}
                      </th>
                      <td className="px-3 py-2">
                        <Checkbox
                          aria-label={t('wizard.readFor', { profile: p.name })}
                          checked={a.read}
                          disabled={admin}
                          onCheckedChange={(c) => {
                            set({ read: c === true, edit: c === true && a.edit });
                          }}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <Checkbox
                          aria-label={t('wizard.editFor', { profile: p.name })}
                          checked={a.edit}
                          disabled={admin}
                          onCheckedChange={(c) => {
                            set({ read: a.read || c === true, edit: c === true });
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}

        {step === 'layouts' ? (
          <div role="group" aria-label={t('wizard.stepLayouts')} className="grid gap-2">
            <p className="text-body-sm text-fg-secondary">{t('wizard.layoutsHelp')}</p>
            {layouts.map((l) => (
              <Checkbox
                key={l.id}
                label={l.name}
                checked={onLayouts.has(l.id)}
                onCheckedChange={(c) => {
                  setOnLayouts((prev) => {
                    const next = new Set(prev);
                    if (c === true) next.add(l.id);
                    else next.delete(l.id);
                    return next;
                  });
                }}
              />
            ))}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
