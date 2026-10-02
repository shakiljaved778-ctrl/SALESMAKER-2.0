'use client';

import type { FieldHistoryDto, RecordPageDto } from '@sm/contracts';
import {
  Banner,
  Button,
  Dialog,
  EmptyState,
  FieldEditor,
  FieldValue,
  FormSection,
  HighlightsPanel,
  IconButton,
  Path,
  RelatedList,
  Skeleton,
  Tabs,
  useToast,
  type FieldEditorValue,
} from '@sm/ui';
import { ArrowRightLeft, Check, FileQuestion, History, Pencil, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import type { z } from 'zod';

import { cellApi } from '../../lib/cell-api';
import { useShell } from '../shell/app-shell';
import { useWorkspaceTab } from '../shell/workspace-tabs';
import { AccountHierarchy } from './account-hierarchy';
import { ConvertDialog } from './convert-dialog';
import {
  cellValue,
  editorValue,
  inlineEditable,
  OBJECT_ICONS,
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

type PageData = z.infer<typeof RecordPageDto>;
type Change = z.infer<typeof FieldHistoryDto>;
type Related = PageData['layout']['relatedLists'][number];

const RELATED_PREVIEW = 5;
const RELATED_FETCH = 50;

interface Format {
  locale: string | undefined;
  timeZone: string | undefined;
}

/** One field on the Overview: its value, and an inline editor when the caller may change it. */
function OverviewField({
  field,
  row,
  readOnly,
  format,
  onSave,
}: {
  field: DescribedField;
  row: RecordRow;
  readOnly: boolean;
  format: Format;
  onSave: (field: DescribedField, value: FieldEditorValue) => Promise<boolean>;
}) {
  const t = useTranslations('records.page');
  const labels = useRecordLabels();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<FieldEditorValue>(null);
  const [saving, setSaving] = useState(false);
  const { value, currencyCode } = cellValue(row[field.name]);
  const canEdit = !readOnly && inlineEditable(field);
  const save = async () => {
    setSaving(true);
    const ok = await onSave(field, draft);
    setSaving(false);
    if (ok) setEditing(false);
  };
  return (
    <div className="group min-w-0 border-b border-line-subtle pb-2">
      <dt className="text-caption text-fg-secondary">{field.label}</dt>
      {editing ? (
        <dd
          className="mt-1 flex items-start gap-1"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false);
            if (e.key === 'Enter' && uiType(field.type) !== 'long_text') {
              e.preventDefault();
              void save();
            }
          }}
        >
          <div className="min-w-0 flex-1">
            <FieldEditor
              type={uiType(field.type)}
              aria-label={field.label}
              value={draft}
              onChange={setDraft}
              labels={labels.editor}
              options={picklistOptions(field)}
              currencyCode={currencyCode}
              maxLength={field.length ?? undefined}
            />
          </div>
          <IconButton
            label={t('save')}
            variant="primary"
            onClick={() => void save()}
            disabled={saving}
          >
            <Check />
          </IconButton>
          <IconButton
            label={t('cancel')}
            variant="ghost"
            onClick={() => {
              setEditing(false);
            }}
          >
            <X />
          </IconButton>
        </dd>
      ) : (
        <dd className="flex min-h-7 items-center gap-1">
          <span className="min-w-0 flex-1">
            <FieldValue
              type={uiType(field.type)}
              value={value}
              currencyCode={currencyCode}
              options={picklistOptions(field)}
              labels={labels.value}
              locale={format.locale}
              timeZone={format.timeZone}
              lookupHref={(v) => {
                const s = sectionForObject(v.object);
                return s ? `/${s}/${v.id}` : undefined;
              }}
            />
          </span>
          {canEdit ? (
            <IconButton
              label={t('editField', { field: field.label })}
              size="sm"
              variant="ghost"
              className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
              onClick={() => {
                setDraft(editorValue(field, row[field.name]));
                setEditing(true);
              }}
            >
              <Pencil />
            </IconButton>
          ) : null}
        </dd>
      )}
    </div>
  );
}

/** A related list: the first few children of this record, with New prefilled to point back. */
function RelatedSection({
  spec,
  recordId,
  format,
}: {
  spec: Related;
  recordId: string;
  format: Format;
}) {
  const t = useTranslations('records.page');
  const labels = useRecordLabels();
  const [rows, setRows] = useState<RecordRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [child, setChild] = useState<DescribedObject | null>(null);
  const section = sectionForObject(spec.object);
  const RelatedIcon = OBJECT_ICONS[spec.object];
  useEffect(() => {
    const load = { cancelled: false };
    const cancelled = () => load.cancelled;
    void (async () => {
      const d = await cellApi<DescribedObject>('GET', `/v1/objects/${spec.object}/describe`);
      if (load.cancelled) return;
      if (d.ok) setChild(d.data);
      const names = d.ok ? d.data.nameFields : [];
      const r = await cellApi<{ items: RecordRow[] }>('POST', '/v1/query', {
        object: spec.object,
        fields: [...new Set([...names, ...spec.columns])],
        where: { field: spec.field, op: 'eq', value: recordId },
        ...(spec.sort ? { orderBy: [spec.sort] } : {}),
        limit: RELATED_FETCH,
      });
      // Narrowing ignores the await above: read the flag fresh.
      if (cancelled()) return;
      if (r.ok) setRows(r.data.items);
      else setFailed(true);
    })();
    return () => {
      load.cancelled = true;
    };
  }, [spec, recordId]);
  const fields = new Map((child?.fields ?? []).map((f) => [f.name, f]));
  const nameSet = new Set(child?.nameFields ?? []);
  return (
    <RelatedList
      title={spec.label}
      {...(RelatedIcon ? { icon: <RelatedIcon /> } : {})}
      status={failed ? 'error' : rows === null ? 'loading' : 'ready'}
      error={<Banner tone="danger">{t('relatedFailed')}</Banner>}
      count={rows?.length}
      countLabel={(n) => t('relatedCount', { count: n })}
      rows={(rows ?? []).slice(0, RELATED_PREVIEW).map((row) => ({
        id: row.id,
        title: recordName(child, row),
        href: section ? `/${section}/${row.id}` : undefined,
        fields: spec.columns
          .filter((c) => !nameSet.has(c))
          .flatMap((c) => {
            const field = fields.get(c);
            if (!field) return [];
            const { value, currencyCode } = cellValue(row[c]);
            return [
              {
                label: field.label,
                value: (
                  <FieldValue
                    type={uiType(field.type)}
                    value={value}
                    currencyCode={currencyCode}
                    options={picklistOptions(field)}
                    labels={labels.value}
                    locale={format.locale}
                    timeZone={format.timeZone}
                    className="text-body-sm"
                  />
                ),
              },
            ];
          })
          .slice(0, 4),
      }))}
      empty={
        <p className="text-body-sm text-fg-secondary">
          {t('relatedEmpty', { objects: spec.label })}
        </p>
      }
      {...(spec.canCreate && section
        ? {
            newLabel: t('new'),
            onNew: () => {
              window.location.assign(`/${section}/new?${spec.field}=${recordId}`);
            },
          }
        : {})}
    />
  );
}

/** History tab: tracked changes, newest first, with load more. */
function HistoryTab({
  object,
  id,
  describe,
  format,
}: {
  object: string;
  id: string;
  describe: DescribedObject;
  format: Format;
}) {
  const t = useTranslations('records.page');
  const labels = useRecordLabels();
  const fmt = useFormatter();
  const [items, setItems] = useState<Change[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const load = useCallback(
    async (after: string | null) => {
      const q = after ? `?cursor=${encodeURIComponent(after)}` : '';
      const r = await cellApi<{ items: Change[]; nextCursor: string | null }>(
        'GET',
        `/v1/records/${object}/${id}/history${q}`,
      );
      if (!r.ok) return;
      setItems((prev) => (after && prev ? [...prev, ...r.data.items] : r.data.items));
      setCursor(r.data.nextCursor);
    },
    [object, id],
  );
  useEffect(() => {
    void load(null);
  }, [load]);
  if (items === null) return <Skeleton className="h-24 w-full" />;
  if (items.length === 0)
    return (
      <EmptyState
        icon={<History />}
        title={t('historyEmpty')}
        description={t('historyEmptyBody')}
      />
    );
  const fields = new Map(describe.fields.map((f) => [f.name, f]));
  const show = (field: DescribedField | undefined, v: unknown) =>
    field ? (
      <FieldValue
        type={uiType(field.type)}
        value={cellValue(v).value}
        options={picklistOptions(field)}
        labels={labels.value}
        locale={format.locale}
        timeZone={format.timeZone}
      />
    ) : (
      String(v)
    );
  return (
    <div className="grid gap-3">
      <table className="w-full text-start text-body-sm">
        <thead className="text-caption text-fg-secondary">
          <tr className="border-b border-line">
            <th className="py-2 text-start font-medium">{t('historyField')}</th>
            <th className="py-2 text-start font-medium">{t('historyOld')}</th>
            <th className="py-2 text-start font-medium">{t('historyNew')}</th>
            <th className="py-2 text-start font-medium">{t('historyBy')}</th>
            <th className="py-2 text-start font-medium">{t('historyWhen')}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => {
            const field = fields.get(c.field);
            return (
              <tr key={c.id} className="border-b border-line-subtle align-top">
                <td className="py-2 pe-3 text-fg">{field?.label ?? c.field}</td>
                <td className="py-2 pe-3">{show(field, c.oldValue)}</td>
                <td className="py-2 pe-3">{show(field, c.newValue)}</td>
                <td className="py-2 pe-3 text-fg">{c.changedBy?.name ?? '—'}</td>
                <td className="py-2 text-fg-secondary">
                  <time dateTime={c.changedAt}>
                    {fmt.dateTime(new Date(c.changedAt), {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </time>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {cursor ? (
        <Button size="sm" className="justify-self-start" onClick={() => void load(cursor)}>
          {t('loadMore')}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Record page (§9.11 T2): Highlights Panel, Path, and the Overview (page layout with inline edit),
 * Related and History tabs. Opening it records a recent item and a workspace tab.
 */
export function RecordPage({
  object,
  section,
  id,
}: {
  object: string;
  section: string;
  id: string;
}) {
  const t = useTranslations('records.page');
  const tl = useTranslations('records.list');
  const labels = useRecordLabels();
  const toast = useToast();
  const router = useRouter();
  const { user } = useShell();
  const format: Format = {
    locale: user?.locale ?? undefined,
    timeZone: user?.timezone ?? undefined,
  };
  const [describe, setDescribe] = useState<DescribedObject | null>(null);
  const [page, setPage] = useState<PageData | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [tab, setTab] = useState('overview');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [converting, setConverting] = useState(false);

  const load = useCallback(async () => {
    const [d, p] = await Promise.all([
      cellApi<DescribedObject>('GET', `/v1/objects/${object}/describe`),
      cellApi<PageData>('GET', `/v1/records/${object}/${id}/page`),
    ]);
    if (!d.ok || !p.ok) {
      setStatus((!d.ok ? d.status : p.ok ? 200 : p.status) === 404 ? 'missing' : 'error');
      return;
    }
    setDescribe(d.data);
    setPage(p.data);
    setStatus('ready');
  }, [object, id]);

  useEffect(() => {
    void load();
    void cellApi('POST', `/v1/records/${object}/${id}/viewed`);
  }, [load, object, id]);

  const row = page?.record;
  const title = row && describe ? recordName(describe, row) : '';
  useWorkspaceTab(title ? { href: `/${section}/${id}`, title } : null);

  const write = async (fields: Record<string, unknown>): Promise<boolean> => {
    if (!row) return false;
    const r = await cellApi<RecordRow>(
      'PATCH',
      `/v1/records/${object}/${id}`,
      { fields },
      { 'if-match': String(row.version) },
    );
    if (r.ok) {
      setPage((prev) => (prev ? { ...prev, record: { ...prev.record, ...r.data } } : prev));
      toast({ tone: 'success', title: tl('saved') });
      return true;
    }
    if (r.problem?.code === 'version_conflict') {
      toast({ tone: 'error', title: tl('conflict') });
      void load();
    } else {
      toast({
        tone: 'error',
        title: t('saveFailed'),
        ...(r.problem?.errors?.[0]?.message ? { description: r.problem.errors[0].message } : {}),
      });
    }
    return false;
  };

  const remove = async () => {
    setConfirmDelete(false);
    const r = await cellApi('DELETE', `/v1/records/${object}/${id}`);
    if (!r.ok) {
      toast({ tone: 'error', title: t('deleteFailed') });
      return;
    }
    toast({
      tone: 'success',
      title: t('deleted', { name: title }),
      durationMs: 8000,
      action: {
        label: t('undo'),
        onClick: () => {
          void cellApi('POST', `/v1/records/${object}/${id}/restore`).then((res) => {
            if (res.ok) router.push(`/${section}/${id}`);
          });
        },
      },
    });
    router.push(`/${section}`);
  };

  if (status === 'loading')
    return (
      <div aria-busy="true" className="grid gap-4 p-[var(--page-padding)]">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  if (status !== 'ready' || !page || !describe || !row)
    return (
      <div className="p-[var(--page-padding)]">
        <EmptyState
          icon={<FileQuestion />}
          title={status === 'missing' ? t('notFound') : t('loadFailed')}
          description={status === 'missing' ? t('notFoundBody') : tl('loadFailedBody')}
          action={
            <Button asChild>
              <Link href={`/${section}`}>
                {t('backToList', { objects: describe?.labelPlural ?? '' })}
              </Link>
            </Button>
          }
        />
      </div>
    );

  const fields = new Map(describe.fields.map((f) => [f.name, f]));
  const Icon = OBJECT_ICONS[object] ?? FileQuestion;
  const owner = row['owner_id'];
  const ownerName =
    typeof owner === 'object' && owner !== null && 'name' in owner && typeof owner.name === 'string'
      ? owner.name
      : null;
  const show = (name: string) => {
    const field = fields.get(name);
    if (!field) return null;
    const { value, currencyCode } = cellValue(row[name]);
    return (
      <FieldValue
        type={uiType(field.type)}
        value={value}
        currencyCode={currencyCode}
        options={picklistOptions(field)}
        labels={labels.value}
        locale={format.locale}
        timeZone={format.timeZone}
      />
    );
  };
  const pathValue = page.path ? row[page.path.field] : null;
  const pathField = page.path ? fields.get(page.path.field) : undefined;
  const canMovePath = Boolean(pathField?.editable && describe.access.edit);

  return (
    <div className="grid gap-4 p-[var(--page-padding)]">
      <HighlightsPanel
        icon={<Icon />}
        objectLabel={describe.label}
        title={title}
        moreActionsLabel={t('moreActions')}
        fields={page.compactFields
          .filter((f) => !describe.nameFields.includes(f) && f !== 'owner_id')
          .slice(0, 5)
          .map((f) => ({ label: fields.get(f)?.label ?? f, value: show(f) }))}
        {...(ownerName
          ? { owner: { name: ownerName, label: fields.get('owner_id')?.label ?? '' } }
          : {})}
        actions={[
          ...(object === 'lead' && describe.access.edit && !row['converted_at']
            ? [
                {
                  label: t('convert'),
                  icon: <ArrowRightLeft />,
                  primary: true,
                  onSelect: () => {
                    setConverting(true);
                  },
                },
              ]
            : []),
          ...(describe.access.edit
            ? [
                {
                  label: t('edit'),
                  icon: <Pencil />,
                  primary: object !== 'lead',
                  onSelect: () => {
                    router.push(`/${section}/${id}/edit`);
                  },
                },
              ]
            : []),
          ...(describe.access.delete
            ? [
                {
                  label: t('delete'),
                  icon: <Trash2 />,
                  destructive: true,
                  onSelect: () => {
                    setConfirmDelete(true);
                  },
                },
              ]
            : []),
        ]}
      />
      {page.path && typeof pathValue === 'string' ? (
        <Path
          stages={page.path.stages.map((s) => ({
            value: s.value,
            label: s.label,
            keyFields: s.keyFields.map((k) => ({
              label: fields.get(k)?.label ?? k,
              value: show(k),
            })),
            ...(s.guidance
              ? { guidance: <p className="whitespace-pre-line">{s.guidance}</p> }
              : {}),
          }))}
          current={pathValue}
          busy={busy}
          labels={{
            path: pathField?.label ?? '',
            completed: t('stageCompleted'),
            current: t('stageCurrent'),
            markComplete: t('markComplete'),
            markCurrent: t('markCurrent'),
            showGuidance: t('showGuidance'),
            hideGuidance: t('hideGuidance'),
            keyFields: t('keyFields'),
            guidance: t('guidance'),
            saving: t('saving'),
          }}
          {...(canMovePath
            ? {
                onMarkComplete: () => {
                  const stages = page.path?.stages ?? [];
                  const next = stages[stages.findIndex((s) => s.value === pathValue) + 1];
                  if (!next || !page.path) return;
                  setBusy(true);
                  void write({ [page.path.field]: next.value }).finally(() => {
                    setBusy(false);
                  });
                },
                onMarkCurrent: (stage: string) => {
                  if (!page.path) return;
                  setBusy(true);
                  void write({ [page.path.field]: stage }).finally(() => {
                    setBusy(false);
                  });
                },
              }
            : {})}
        />
      ) : null}
      <Tabs
        label={t('tabs')}
        value={tab}
        onValueChange={setTab}
        items={[
          {
            value: 'overview',
            label: t('overview'),
            content: (
              <div className="grid gap-6 rounded-md border border-line bg-surface p-4 shadow-e1">
                {page.layout.sections.map((s) => (
                  <FormSection key={s.key} title={s.label ?? undefined} columns={s.columns}>
                    {s.fields.map((f) => {
                      const field = fields.get(f.field);
                      return field ? (
                        <dl key={f.field} className="contents">
                          <OverviewField
                            field={field}
                            row={row}
                            readOnly={f.readOnly || !describe.access.edit}
                            format={format}
                            onSave={(fd, v) => write({ [fd.name]: writeValue(v) })}
                          />
                        </dl>
                      ) : null;
                    })}
                  </FormSection>
                ))}
              </div>
            ),
          },
          {
            value: 'related',
            label: t('related'),
            count: page.layout.relatedLists.length,
            content: (
              <div className="grid gap-4 lg:grid-cols-2">
                {page.layout.relatedLists.length === 0 ? (
                  <p className="text-body-sm text-fg-secondary">{t('noRelated')}</p>
                ) : (
                  page.layout.relatedLists.map((r) => (
                    <RelatedSection
                      key={`${r.object}.${r.field}`}
                      spec={r}
                      recordId={id}
                      format={format}
                    />
                  ))
                )}
              </div>
            ),
          },
          ...(object === 'account'
            ? [
                {
                  value: 'hierarchy',
                  label: t('hierarchy'),
                  content: (
                    <div className="rounded-md border border-line bg-surface p-4 shadow-e1">
                      {tab === 'hierarchy' ? <AccountHierarchy accountId={id} /> : null}
                    </div>
                  ),
                },
              ]
            : []),
          {
            value: 'history',
            label: t('history'),
            content: (
              <div className="rounded-md border border-line bg-surface p-4 shadow-e1">
                <HistoryTab object={object} id={id} describe={describe} format={format} />
              </div>
            ),
          },
        ]}
      />
      {object === 'lead' ? (
        <ConvertDialog
          lead={row}
          describe={describe}
          open={converting}
          onOpenChange={setConverting}
        />
      ) : null}
      <Dialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('deleteTitle', { name: title })}
        closeLabel={t('cancel')}
        footer={
          <>
            <Button
              onClick={() => {
                setConfirmDelete(false);
              }}
            >
              {t('cancel')}
            </Button>
            <Button variant="danger" onClick={() => void remove()}>
              {t('delete')}
            </Button>
          </>
        }
      >
        <p className="text-body text-fg">{t('deleteBody')}</p>
      </Dialog>
    </div>
  );
}
