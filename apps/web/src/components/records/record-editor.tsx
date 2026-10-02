'use client';

import type { CreateLayoutDto, RecordPageDto, SearchResultDto } from '@sm/contracts';
import {
  Banner,
  Button,
  Dialog,
  FieldEditor,
  FieldValue,
  FormField,
  FormSection,
  FormSpan,
  Radio,
  RadioGroup,
  RecordForm,
  Skeleton,
  useToast,
  type FieldEditorValue,
  type LookupValue,
} from '@sm/ui';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { z } from 'zod';

import { cellApi } from '../../lib/cell-api';
import {
  cellValue,
  editorValue,
  picklistOptions,
  recordName,
  sectionForObject,
  uiType,
  writeValue,
  type DescribedField,
  type DescribedObject,
  type RecordRow,
} from './fields';
import { useRecordLabels } from './use-record-labels';

type Layout = z.infer<typeof CreateLayoutDto>;
type Page = z.infer<typeof RecordPageDto>;
type Section = Layout['sections'][number];
type Values = Record<string, FieldEditorValue>;

const LOOKUP_RESULTS = 8;
/** Error codes with their own wording; anything else reads "check this value". */
const KNOWN_ERRORS = {
  required: 'errors.required',
  not_in_picklist: 'errors.notInPicklist',
  too_long: 'errors.tooLong',
  invalid_type: 'errors.invalidType',
  invalid_reference: 'errors.invalidReference',
  read_only: 'errors.readOnly',
  not_editable: 'errors.readOnly',
} as const;

/** Fields the form can edit: writable for the caller, and lookups only to searchable objects. */
function formEditable(field: DescribedField, readOnly: boolean): boolean {
  if (readOnly || !field.editable || field.type === 'auto_number') return false;
  // Lookups search their targets; only object homes are searchable (users and record types are
  // set elsewhere: owner change and the record-type picker).
  if (uiType(field.type) === 'lookup')
    return (
      field.referenceTo.length > 0 && field.referenceTo.every((o) => sectionForObject(o) !== null)
    );
  return true;
}

/** A lookup editor that searches the referenced objects (§9.10: debounced async search). */
function useLookupSearch(field: DescribedField) {
  const [results, setResults] = useState<LookupValue[]>([]);
  const [loading, setLoading] = useState(false);
  const onSearch = useCallback(
    (q: string) => {
      const text = q.trim();
      if (!text) {
        setResults([]);
        return;
      }
      setLoading(true);
      const params = new URLSearchParams({
        q: text,
        objects: field.referenceTo.join(','),
        limit: String(LOOKUP_RESULTS),
      });
      void cellApi<z.infer<typeof SearchResultDto>>('GET', `/v1/search?${params.toString()}`).then(
        (r) => {
          setLoading(false);
          if (!r.ok) return;
          setResults(
            r.data.groups.flatMap((g) =>
              g.hits.map((h) => ({ id: h.id, name: h.name ?? h.id, object: g.object })),
            ),
          );
        },
      );
    },
    [field.referenceTo],
  );
  return { results, loading, onSearch };
}

function EditorField({
  field,
  required,
  value,
  error,
  currencyCode,
  onChange,
}: {
  field: DescribedField;
  required: boolean;
  value: FieldEditorValue | undefined;
  error: string | undefined;
  currencyCode: string | undefined;
  onChange: (value: FieldEditorValue) => void;
}) {
  const labels = useRecordLabels();
  const tc = useTranslations('common.states');
  const lookup = useLookupSearch(field);
  return (
    <FormField
      label={field.label}
      required={required}
      requiredLabel={tc('required')}
      helper={field.helpText ?? undefined}
      error={error}
    >
      <FieldEditor
        type={uiType(field.type)}
        value={value}
        onChange={onChange}
        labels={labels.editor}
        options={picklistOptions(field)}
        currencyCode={currencyCode}
        maxLength={field.length ?? undefined}
        lookup={uiType(field.type) === 'lookup' ? lookup : undefined}
      />
    </FormField>
  );
}

export interface RecordEditorProps {
  object: string;
  section: string;
  /** Edit this record; omit to create one. */
  id?: string;
  /** Quick create: only the required fields, in a dialog (§9.11). */
  quick?: boolean;
  /** Prefilled values from the URL (e.g. `account_id` from a related list's New). */
  prefill?: Record<string, string>;
  recordTypeId?: string;
  /** Called after saving (quick create) or cancelling; the full page navigates instead. */
  onDone?: (saved: RecordRow | null) => void;
}

/**
 * Create and edit (§9.11): the caller's page layout as a form, required fields marked, FLS-aware
 * editors, field-keyed errors from the server, an idempotent create, an optimistic-locked edit with
 * a conflict dialog on 409, and an unsaved-changes guard.
 */
export function RecordEditor({
  object,
  section,
  id,
  quick = false,
  prefill = {},
  recordTypeId: initialType,
  onDone,
}: RecordEditorProps) {
  const t = useTranslations('records.editor');
  const tc = useTranslations('common.actions');
  const td = useTranslations('setup.common');
  const labels = useRecordLabels();
  const toast = useToast();
  const router = useRouter();
  const [describe, setDescribe] = useState<DescribedObject | null>(null);
  const [recordType, setRecordType] = useState<string | null>(initialType ?? null);
  const [picking, setPicking] = useState(false);
  const [sections, setSections] = useState<Section[] | null>(null);
  const [record, setRecord] = useState<RecordRow | null>(null);
  const [values, setValues] = useState<Values>({});
  const [initial, setInitial] = useState<Values>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [failed, setFailed] = useState(false);
  // One key per form: a retried create (double click, flaky network) makes one record.
  const idempotencyKey = useRef(globalThis.crypto.randomUUID());
  const prefillKey = JSON.stringify(prefill);
  // The record type and prefill the new-record form was built for. Loading the default layout
  // fills in its record type, which must not trigger a second load that would wipe what the
  // user has typed since.
  const loadedFor = useRef<string | null>(null);

  const fields = useMemo(
    () => new Map((describe?.fields ?? []).map((f) => [f.name, f])),
    [describe],
  );
  const dirty = Object.keys(values).some(
    (k) => JSON.stringify(values[k] ?? null) !== JSON.stringify(initial[k] ?? null),
  );

  useEffect(() => {
    void cellApi<DescribedObject>('GET', `/v1/objects/${object}/describe`).then((r) => {
      if (!r.ok) {
        setFailed(true);
        return;
      }
      setDescribe(r.data);
      const active = r.data.recordTypes;
      if (!id && !initialType && active.length > 1) {
        setRecordType(active.find((x) => x.default)?.id ?? active[0]?.id ?? null);
        setPicking(true);
      }
    });
  }, [object, id, initialType]);

  const load = useCallback(async () => {
    if (!describe || picking) return;
    if (id) {
      const r = await cellApi<Page>('GET', `/v1/records/${object}/${id}/page`);
      if (!r.ok) {
        setFailed(true);
        return;
      }
      const row = r.data.record as RecordRow;
      const start: Values = {};
      for (const s of r.data.layout.sections)
        for (const f of s.fields) {
          const field = describe.fields.find((x) => x.name === f.field);
          if (field) start[f.field] = editorValue(field, row[f.field]);
        }
      setRecord(row);
      setSections(r.data.layout.sections);
      setValues(start);
      setInitial(start);
      return;
    }
    if (loadedFor.current === `${recordType ?? ''}|${prefillKey}`) return;
    const q = recordType ? `?recordTypeId=${recordType}` : '';
    const r = await cellApi<Layout>('GET', `/v1/objects/${object}/layout${q}`);
    if (!r.ok) {
      setFailed(true);
      return;
    }
    loadedFor.current = `${r.data.recordTypeId}|${prefillKey}`;
    const start: Values = {};
    const given = JSON.parse(prefillKey) as Record<string, string>;
    for (const [name, raw] of Object.entries(given)) {
      const field = describe.fields.find((x) => x.name === name);
      if (!field?.editable) continue;
      if (uiType(field.type) === 'lookup') {
        const target = field.referenceTo[0] ?? '';
        const res = await cellApi<RecordRow>('GET', `/v1/records/${target}/${raw}`);
        const d = await cellApi<DescribedObject>('GET', `/v1/objects/${target}/describe`);
        if (res.ok)
          start[name] = {
            id: raw,
            name: recordName(d.ok ? d.data : null, res.data),
            object: target,
          };
      } else start[name] = raw;
    }
    // Picklist defaults (§5.3) start selected on a new record.
    for (const s of r.data.sections)
      for (const f of s.fields) {
        const field = describe.fields.find((x) => x.name === f.field);
        const preset = field?.picklistValues?.find((v) => v.default);
        if (preset && start[f.field] === undefined) start[f.field] = preset.value;
      }
    setRecordType(r.data.recordTypeId);
    setSections(r.data.sections);
    setValues(start);
    setInitial(id ? start : {});
  }, [describe, picking, id, object, recordType, prefillKey]);

  useEffect(() => {
    void load();
  }, [load]);

  // Leaving the page with unsaved changes asks first (§9.11).
  useEffect(() => {
    if (!dirty || quick) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [dirty, quick]);

  const visibleSections = useMemo(() => {
    if (!sections) return [];
    return sections
      .map((s) => ({
        ...s,
        fields: s.fields.filter((f) => {
          const field = fields.get(f.field);
          if (!field) return false;
          if (quick) return f.required && formEditable(field, f.readOnly);
          // Create forms show what can be entered; edit forms also show read-only values.
          return id ? true : formEditable(field, f.readOnly);
        }),
      }))
      .filter((s) => s.fields.length > 0);
  }, [sections, fields, quick, id]);

  const errorText = (field: string, code: string, message: string) => {
    if (code === 'validation_rule') return message;
    const label = fields.get(field)?.label ?? field;
    const key = Object.hasOwn(KNOWN_ERRORS, code)
      ? KNOWN_ERRORS[code as keyof typeof KNOWN_ERRORS]
      : 'errors.invalid';
    return t(key, { field: label });
  };

  const close = (saved: RecordRow | null) => {
    if (onDone) onDone(saved);
    else router.push(saved ? `/${section}/${saved.id}` : id ? `/${section}/${id}` : `/${section}`);
  };

  const save = async () => {
    setErrors({});
    setFormError('');
    // Client-side required check first: the cheap, obvious mistakes get named at once.
    const missing: Record<string, string> = {};
    for (const s of visibleSections)
      for (const f of s.fields) {
        const field = fields.get(f.field);
        const v = values[f.field];
        const empty =
          v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
        if (field && f.required && formEditable(field, f.readOnly) && empty)
          missing[f.field] = errorText(f.field, 'required', '');
      }
    if (Object.keys(missing).length) {
      setErrors(missing);
      setFormError(t('fixErrors'));
      return;
    }
    const out: Record<string, unknown> = {};
    for (const [name, v] of Object.entries(values)) {
      const field = fields.get(name);
      if (!field || !formEditable(field, false)) continue;
      const changed = JSON.stringify(v ?? null) !== JSON.stringify(initial[name] ?? null);
      if (id ? changed : v !== null && v !== '') out[name] = writeValue(v);
    }
    if (!id && recordType && fields.get('record_type_id')?.editable)
      out['record_type_id'] = recordType;
    if (id && Object.keys(out).length === 0) {
      close(record);
      return;
    }
    setSaving(true);
    const r = id
      ? await cellApi<RecordRow>(
          'PATCH',
          `/v1/records/${object}/${id}`,
          { fields: out },
          { 'if-match': String(record?.version ?? '') },
        )
      : await cellApi<RecordRow>(
          'POST',
          `/v1/records/${object}`,
          { fields: out },
          { 'idempotency-key': idempotencyKey.current },
        );
    setSaving(false);
    if (r.ok) {
      setInitial(values);
      const name = describe ? recordName(describe, r.data) : '';
      toast({
        tone: 'success',
        title: id ? t('saved', { name }) : t('created', { name }),
        ...(quick && !id
          ? {
              action: {
                label: t('view'),
                onClick: () => {
                  router.push(`/${section}/${r.data.id}`);
                },
              },
            }
          : {}),
      });
      close(r.data);
      return;
    }
    if (r.problem?.code === 'version_conflict') {
      setConflict(true);
      return;
    }
    const keyed: Record<string, string> = {};
    const loose: string[] = [];
    const shown = new Set(visibleSections.flatMap((s) => s.fields.map((f) => f.field)));
    for (const e of r.problem?.errors ?? []) {
      const text = errorText(e.field, e.code, e.message);
      if (shown.has(e.field)) keyed[e.field] = text;
      else loose.push(text);
    }
    setErrors(keyed);
    setFormError(
      loose.length
        ? loose.join(' ')
        : Object.keys(keyed).length
          ? t('fixErrors')
          : r.status === 403
            ? td('notAllowed')
            : td('unavailable'),
    );
  };

  const cancel = () => {
    if (dirty) setLeaving(true);
    else close(null);
  };

  if (failed)
    return (
      <Banner tone="danger" title={t('loadFailed')}>
        {td('unavailable')}
      </Banner>
    );
  if (!describe) return <Skeleton className="h-64 w-full" />;

  if (picking)
    return (
      <div className="grid max-w-xl gap-4">
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-title-3 text-fg">{t('recordType')}</legend>
          <RadioGroup
            value={recordType ?? ''}
            onValueChange={(v) => {
              setRecordType(v);
            }}
          >
            {describe.recordTypes.map((rt) => (
              <Radio key={rt.id} value={rt.id} label={rt.name} />
            ))}
          </RadioGroup>
        </fieldset>
        <div className="flex justify-end gap-2">
          <Button
            onClick={() => {
              close(null);
            }}
          >
            {tc('cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!recordType}
            onClick={() => {
              setPicking(false);
            }}
          >
            {tc('continue')}
          </Button>
        </div>
      </div>
    );

  if (!sections) return <Skeleton className="h-64 w-full" />;
  // Money fields edit in the record's currency (any Money value on it names it).
  const currency = record
    ? Object.values(record)
        .map((v) => cellValue(v).currencyCode)
        .find((c) => c !== undefined)
    : undefined;

  return (
    <>
      <RecordForm
        aria-label={
          id
            ? t('editTitle', { object: describe.label })
            : t('newTitle', { object: describe.label })
        }
        onSubmit={() => void save()}
        errors={formError ? <Banner tone="danger">{formError}</Banner> : null}
        footer={
          <>
            <Button type="button" onClick={cancel}>
              {tc('cancel')}
            </Button>
            <Button type="submit" variant="primary" loading={saving} loadingLabel={t('saving')}>
              {tc('save')}
            </Button>
          </>
        }
      >
        {visibleSections.map((s) => (
          <FormSection
            key={s.key}
            title={quick ? undefined : (s.label ?? undefined)}
            columns={quick ? 1 : s.columns}
          >
            {s.fields.map((f) => {
              const field = fields.get(f.field);
              if (!field) return null;
              const editable = formEditable(field, f.readOnly);
              const node = editable ? (
                <EditorField
                  key={f.field}
                  field={field}
                  required={f.required}
                  value={values[f.field]}
                  error={errors[f.field]}
                  currencyCode={currency}
                  onChange={(v) => {
                    setValues((prev) => ({ ...prev, [f.field]: v }));
                  }}
                />
              ) : (
                <FormField key={f.field} label={field.label}>
                  <div className="flex min-h-[var(--control-height)] items-center">
                    <FieldValue
                      type={uiType(field.type)}
                      value={record ? cellValue(record[f.field]).value : null}
                      currencyCode={record ? cellValue(record[f.field]).currencyCode : undefined}
                      options={picklistOptions(field)}
                      labels={labels.value}
                    />
                  </div>
                </FormField>
              );
              return uiType(field.type) === 'long_text' && s.columns === 2 && !quick ? (
                <FormSpan key={f.field}>{node}</FormSpan>
              ) : (
                node
              );
            })}
          </FormSection>
        ))}
      </RecordForm>
      <Dialog
        open={conflict}
        onOpenChange={setConflict}
        title={t('conflictTitle')}
        closeLabel={tc('close')}
        footer={
          <>
            <Button
              onClick={() => {
                setConflict(false);
              }}
            >
              {t('keepEditing')}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setConflict(false);
                void load();
              }}
            >
              {t('reload')}
            </Button>
          </>
        }
      >
        <p className="text-body text-fg">{t('conflictBody')}</p>
      </Dialog>
      <Dialog
        open={leaving}
        onOpenChange={setLeaving}
        title={td('discardTitle')}
        closeLabel={tc('close')}
        footer={
          <>
            <Button
              onClick={() => {
                setLeaving(false);
              }}
            >
              {td('keepEditing')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setLeaving(false);
                close(null);
              }}
            >
              {td('discard')}
            </Button>
          </>
        }
      >
        <p className="text-body text-fg">{td('discardBody')}</p>
      </Dialog>
    </>
  );
}
