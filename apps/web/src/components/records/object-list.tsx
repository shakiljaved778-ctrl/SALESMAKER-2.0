'use client';

import type { ListViewDto, ListViewResultsDto } from '@sm/contracts';
import {
  Banner,
  Button,
  DataGrid,
  DropdownMenu,
  EmptyState,
  FieldEditor,
  FieldValue,
  IconButton,
  Input,
  Select,
  Switch,
  useToast,
  type DataGridColumn,
  type FieldEditorValue,
  type MenuEntry,
} from '@sm/ui';
import {
  Columns3,
  Inbox,
  Lock,
  MoreHorizontal,
  PanelRight,
  Plus,
  Search,
  SearchX,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { z } from 'zod';

import { cellApi } from '../../lib/cell-api';
import type { ApiResult } from '../../lib/client-api';
import { applyDisplay } from '../../lib/display';
import { DENSITIES, type Density } from '../../lib/preferences';
import { useShell } from '../shell/app-shell';
import {
  cellValue,
  editorValue,
  inlineEditable,
  picklistOptions,
  recordName,
  sectionForObject,
  uiType,
  writeValue,
  type DescribedField,
  type DescribedObject,
  type RecordRow,
} from './fields';
import { ColumnChooser, MassActionDialog, SaveViewDialog, type MassKind } from './list-dialogs';
import { RecordPreview } from './record-preview';
import { useRecordLabels } from './use-record-labels';

type View = z.infer<typeof ListViewDto>;
type Results = z.infer<typeof ListViewResultsDto>;
type Sort = View['sort'];
type Filter = Record<string, unknown>;
type Status = 'loading' | 'ready' | 'error' | 'no-permission';

const PAGE = 50;
const SEARCH_DEBOUNCE_MS = 250;
const DENSITY_KEY = {
  comfortable: 'densityComfortable',
  default: 'densityDefault',
  compact: 'densityCompact',
} as const;

const and = (parts: (Filter | null | undefined)[]): Filter | undefined => {
  const list = parts.filter((p): p is Filter => Boolean(p));
  if (list.length === 0) return undefined;
  return list.length === 1 ? list[0] : { and: list };
};

/** The editor shown in a grid cell: picklists and checkboxes save on change, the rest on Enter or blur. */
function InlineEditor({
  field,
  row,
  done,
}: {
  field: DescribedField;
  row: RecordRow;
  done: (value?: unknown) => void;
}) {
  const labels = useRecordLabels();
  const [value, setValue] = useState<FieldEditorValue>(() => editorValue(field, row[field.name]));
  const ref = useRef<HTMLDivElement>(null);
  const kind = uiType(field.type);
  const immediate = kind === 'picklist' || kind === 'checkbox';
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, textarea, button')?.focus();
  }, []);
  return (
    <div
      ref={ref}
      className="w-full"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !immediate && kind !== 'long_text') {
          e.preventDefault();
          e.stopPropagation();
          done(value);
        }
      }}
      onBlur={(e) => {
        const to = e.relatedTarget;
        // Focus moving into the editor's own dropdown (a portal) is not leaving the editor.
        if (e.currentTarget.contains(to) || to?.closest('[role="listbox"]')) return;
        // Leaving saves typed values; a picklist or checkbox left unchanged just closes.
        done(immediate ? undefined : value);
      }}
    >
      <FieldEditor
        type={kind}
        aria-label={labels.edit(field.label)}
        value={value}
        labels={labels.editor}
        options={picklistOptions(field)}
        currencyCode={cellValue(row[field.name]).currencyCode}
        maxLength={field.length ?? undefined}
        onChange={(v) => {
          setValue(v);
          if (immediate) done(v);
        }}
      />
    </div>
  );
}

/**
 * Object home (§9.11 T1): saved views, quick filters, search, column chooser, server-side sort,
 * count, load more, inline edit, bulk selection with mass actions, split view, density and the
 * J/K/X/E/Enter keys. Every read and write goes through the records API as the viewer.
 */
export function ObjectList({ object, section }: { object: string; section: string }) {
  const t = useTranslations('records.list');
  const tv = useTranslations('records.views');
  const tm = useTranslations('records.mass');
  const tc = useTranslations('common.actions');
  const labels = useRecordLabels();
  const toast = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { user } = useShell();
  const locale = user?.locale ?? undefined;
  const timeZone = user?.timezone ?? undefined;
  const canShare = Boolean(user?.permissions.includes('customize_application'));
  const canMassUpdate = Boolean(user?.permissions.includes('mass_update'));

  const [describe, setDescribe] = useState<DescribedObject | null>(null);
  const [views, setViews] = useState<View[]>([]);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [viewId, setViewId] = useState<string | null>(params.get('view'));
  const [status, setStatus] = useState<Status>('loading');
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [count, setCount] = useState<Results['count']>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [mine, setMine] = useState(false);
  const [quick, setQuick] = useState<string>('');
  const [sortOverride, setSortOverride] = useState<Sort | null>(null);
  const [columnsOverride, setColumnsOverride] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [split, setSplit] = useState(false);
  const [preview, setPreview] = useState<RecordRow | null>(null);
  const [dialog, setDialog] = useState<'save' | 'saveAs' | MassKind | null>(null);
  const [density, setDensity] = useState<Density>(user?.density ?? 'default');

  const view = views.find((v) => v.id === viewId) ?? null;
  const fieldsByName = useMemo(
    () => new Map((describe?.fields ?? []).map((f) => [f.name, f])),
    [describe],
  );
  const nameField = describe?.nameFields.at(-1) ?? 'name';
  const objects = describe?.labelPlural ?? '';

  // Quick filter: the first picklist among the view's columns (status, stage, rating…).
  const quickField = useMemo(
    () =>
      (view?.columns ?? [])
        .map((c) => fieldsByName.get(c))
        .find((f): f is DescribedField => f?.type === 'picklist'),
    [view, fieldsByName],
  );

  // ── Loading ────────────────────────────────────────────────────────────────────────────
  const fail = useCallback((result: ApiResult<unknown>) => {
    setStatus(result.status === 403 || result.status === 404 ? 'no-permission' : 'error');
  }, []);

  useEffect(() => {
    const load = { cancelled: false };
    void (async () => {
      const [d, v] = await Promise.all([
        cellApi<DescribedObject>('GET', `/v1/objects/${object}/describe`),
        cellApi<{ items: View[]; pinnedId: string | null }>(
          'GET',
          `/v1/objects/${object}/list-views`,
        ),
      ]);
      if (load.cancelled) return;
      if (!d.ok) {
        fail(d);
        return;
      }
      if (!v.ok) {
        fail(v);
        return;
      }
      setDescribe(d.data);
      setViews(v.data.items);
      setPinnedId(v.data.pinnedId);
      setViewId((current) =>
        current && v.data.items.some((x) => x.id === current)
          ? current
          : (v.data.pinnedId ?? v.data.items[0]?.id ?? null),
      );
    })();
    return () => {
      load.cancelled = true;
    };
  }, [object, fail]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchText.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [searchText]);

  const request = useMemo(() => {
    const where = and([
      mine ? { field: 'owner_id', op: 'eq', value: '$me' } : null,
      quick && quickField ? { field: quickField.name, op: 'eq', value: quick } : null,
    ]);
    return {
      ...(where ? { where } : {}),
      ...(search ? { search } : {}),
      ...(sortOverride ? { sort: sortOverride } : {}),
      ...(columnsOverride ? { columns: columnsOverride } : {}),
    };
  }, [mine, quick, quickField, search, sortOverride, columnsOverride]);
  const quickWhere = request.where;

  const run = useCallback(
    async (after: string | null) => {
      if (!viewId) return;
      const result = await cellApi<Results>(
        'POST',
        `/v1/objects/${object}/list-views/${viewId}/results`,
        {
          ...request,
          limit: PAGE,
          ...(after ? { cursor: after } : { count: true }),
        },
      );
      if (!result.ok) {
        fail(result);
        return;
      }
      setStatus('ready');
      setRows((prev) => (after ? [...prev, ...result.data.items] : result.data.items));
      setColumns(result.data.columns);
      setCursor(result.data.nextCursor);
      if (!after) setCount(result.data.count);
    },
    [object, viewId, request, fail],
  );

  useEffect(() => {
    setSelected(new Set());
    setAllMatching(false);
    void run(null);
  }, [run]);

  const chooseView = (id: string) => {
    setViewId(id);
    setSortOverride(null);
    setColumnsOverride(null);
    setQuick('');
    setStatus('loading');
    const next = new URLSearchParams(params.toString());
    next.set('view', id);
    router.replace(`${pathname}?${next.toString()}`);
  };

  // ── Grid columns ───────────────────────────────────────────────────────────────────────
  const gridColumns = useMemo<DataGridColumn<RecordRow>[]>(() => {
    const names = [...new Set([nameField, ...columns])].filter((c) => fieldsByName.has(c));
    return names.map((name) => {
      const field = fieldsByName.get(name) as DescribedField;
      const kind = uiType(field.type);
      const isName = name === nameField;
      return {
        id: name,
        header: isName && (describe?.nameFields.length ?? 0) > 1 ? t('name') : field.label,
        value: (row) => cellValue(row[name]).value,
        sortable: field.sortable,
        required: isName,
        width: isName ? 220 : kind === 'long_text' ? 280 : 170,
        align: kind === 'number' || kind === 'currency' || kind === 'percent' ? 'end' : 'start',
        editable: !isName && inlineEditable(field),
        cell: (row) =>
          isName ? (
            <Link
              href={`/${section}/${row.id}`}
              prefetch={false}
              className="truncate text-link underline-offset-4 hover:underline"
              tabIndex={-1}
            >
              {recordName(describe, row)}
            </Link>
          ) : (
            <FieldValue
              type={kind}
              value={cellValue(row[name]).value}
              currencyCode={cellValue(row[name]).currencyCode}
              options={picklistOptions(field)}
              labels={labels.value}
              locale={locale}
              timeZone={timeZone}
              lookupHref={(v) => {
                const target = sectionForObject(v.object);
                return target ? `/${target}/${v.id}` : undefined;
              }}
              className="truncate"
            />
          ),
      };
    });
  }, [columns, nameField, fieldsByName, describe, section, labels, locale, timeZone, t]);

  const sorting = (sortOverride ?? view?.sort ?? []).map((s) => ({
    id: s.field,
    desc: s.direction === 'desc',
  }));

  // ── Inline edit ────────────────────────────────────────────────────────────────────────
  const saveCell = async (row: RecordRow, field: DescribedField, value: unknown) => {
    const result = await cellApi<RecordRow>(
      'PATCH',
      `/v1/records/${object}/${row.id}`,
      { fields: { [field.name]: writeValue(value as FieldEditorValue) } },
      { 'if-match': String(row.version) },
    );
    if (result.ok) {
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, ...result.data } : r)));
      toast({ tone: 'success', title: t('saved') });
    } else if (result.problem?.code === 'version_conflict') {
      toast({ tone: 'error', title: t('conflict') });
      void run(null);
    } else {
      toast({
        tone: 'error',
        title: t('saveFailed', { field: field.label }),
        ...(result.problem?.detail ? { description: result.problem.detail } : {}),
      });
    }
  };

  // ── Views ──────────────────────────────────────────────────────────────────────────────
  const reloadViews = async (select?: string) => {
    const v = await cellApi<{ items: View[]; pinnedId: string | null }>(
      'GET',
      `/v1/objects/${object}/list-views`,
    );
    if (!v.ok) return;
    setViews(v.data.items);
    setPinnedId(v.data.pinnedId);
    if (select) chooseView(select);
  };

  const currentSort = sortOverride ?? view?.sort ?? [];
  const currentColumns = columnsOverride ?? view?.columns ?? [];
  const dirty = sortOverride !== null || columnsOverride !== null;

  const saveView = async () => {
    if (!view) return;
    const result = await cellApi<View>(
      'PATCH',
      `/v1/objects/${object}/list-views/${view.id}`,
      { columns: currentColumns, sort: currentSort },
      { 'if-match': String(view.version) },
    );
    if (!result.ok) {
      toast({ tone: 'error', title: t('saveFailed', { field: view.name }) });
      return;
    }
    setSortOverride(null);
    setColumnsOverride(null);
    toast({ tone: 'success', title: tv('saved') });
    await reloadViews();
  };

  const pin = async () => {
    if (!view) return;
    const result = await cellApi('PUT', `/v1/objects/${object}/list-views/${view.id}/pin`);
    if (result.ok) {
      setPinnedId(view.id);
      toast({ tone: 'success', title: tv('pinnedToast', { name: view.name }) });
    }
  };

  const deleteView = async () => {
    if (!view) return;
    const result = await cellApi('DELETE', `/v1/objects/${object}/list-views/${view.id}`);
    if (!result.ok) return;
    toast({ tone: 'success', title: tv('deleted') });
    const first = views.find((v) => v.id !== view.id);
    await reloadViews(first?.id);
  };

  const menu: MenuEntry[] = [
    ...(view && pinnedId !== view.id
      ? [{ type: 'item' as const, label: t('pin'), onSelect: () => void pin() }]
      : []),
    ...(view?.editable && dirty
      ? [{ type: 'item' as const, label: t('saveView'), onSelect: () => void saveView() }]
      : []),
    {
      type: 'item',
      label: t('saveAs'),
      onSelect: () => {
        setDialog('saveAs');
      },
    },
    { type: 'separator' },
    {
      type: 'radio',
      label: t('density'),
      value: density,
      options: DENSITIES.map((d) => ({ value: d, label: t(DENSITY_KEY[d]) })),
      onValueChange: (value) => {
        const next = value as Density;
        setDensity(next);
        applyDisplay({ density: next });
      },
    },
    ...(view?.editable && view.systemKey === null
      ? [
          { type: 'separator' as const },
          {
            type: 'item' as const,
            label: t('deleteView'),
            destructive: true,
            onSelect: () => void deleteView(),
          },
        ]
      : []),
  ];

  // ── Mass actions ───────────────────────────────────────────────────────────────────────
  const viewFilter = (view?.filter as Filter | null | undefined) ?? null;
  const target = useMemo(() => {
    if (!allMatching) return { ids: [...selected] };
    const where = and([
      viewFilter,
      quickWhere ?? null,
      search ? { field: nameField, op: 'contains', value: search } : null,
    ]);
    return where ? { where } : {};
  }, [allMatching, selected, viewFilter, quickWhere, search, nameField]);
  const selectedCount = allMatching ? (count?.count ?? selected.size) : selected.size;
  const allLoadedSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  // ── Render ─────────────────────────────────────────────────────────────────────────────
  const countText = count
    ? count.capped
      ? t('countCapped', { count: count.count })
      : t('count', { count: count.count })
    : '';

  const filtered = Boolean(quickWhere) || search !== '';
  const grid = (
    <DataGrid<RecordRow>
      label={view ? `${objects}: ${view.name}` : objects}
      rows={rows}
      rowId={(r) => r.id}
      rowLabel={(r) => recordName(describe, r)}
      columns={gridColumns}
      labels={labels.grid}
      status={status}
      listKeys
      filtered={filtered}
      height="100%"
      sorting={sorting}
      onSortingChange={(next) => {
        setSortOverride(
          next.slice(0, 3).map((s) => ({ field: s.id, direction: s.desc ? 'desc' : 'asc' })),
        );
      }}
      selected={selected}
      onSelectedChange={(next) => {
        setSelected(next);
        setAllMatching(false);
      }}
      onRowOpen={(row) => {
        router.push(`/${section}/${row.id}`);
      }}
      onActiveRowChange={split ? setPreview : undefined}
      renderEditor={(row, column, done) => {
        const field = fieldsByName.get(column.id);
        return field ? <InlineEditor field={field} row={row} done={done} /> : null;
      }}
      onCellEdit={(row, column, value) => {
        const field = fieldsByName.get(column.id);
        if (field) void saveCell(row, field, value);
      }}
      hasMore={cursor !== null}
      loadingMore={loadingMore}
      onLoadMore={() => {
        setLoadingMore(true);
        void run(cursor).finally(() => {
          setLoadingMore(false);
        });
      }}
      empty={
        <EmptyState
          icon={<Inbox />}
          title={t('emptyTitle', { objects: objects.toLocaleLowerCase(locale) })}
          description={t('emptyBody')}
          {...(describe?.access.create
            ? {
                action: (
                  <Button variant="primary" asChild>
                    <Link href={`/${section}/new`} prefetch={false}>
                      {t('new')}
                    </Link>
                  </Button>
                ),
              }
            : {})}
        />
      }
      noResults={
        <EmptyState
          icon={<SearchX />}
          title={t('noResultsTitle')}
          description={t('noResultsBody')}
          action={
            <Button
              onClick={() => {
                setSearchText('');
                setMine(false);
                setQuick('');
              }}
            >
              {t('clearFilters')}
            </Button>
          }
        />
      }
      error={
        <Banner
          tone="danger"
          title={t('loadFailed')}
          action={
            <Button size="sm" onClick={() => void run(null)}>
              {tc('retry')}
            </Button>
          }
        >
          {t('loadFailedBody')}
        </Banner>
      }
      noPermission={
        <EmptyState
          icon={<Lock />}
          title={t('noAccessTitle', { objects: objects.toLocaleLowerCase(locale) })}
          description={t('noAccessBody')}
        />
      }
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-[var(--page-padding)]">
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <h1 className="text-title-1 text-fg">{objects}</h1>
          <p className="text-caption text-fg-secondary" aria-live="polite">
            {countText}
          </p>
        </div>
        <div className="w-64">
          <Select
            aria-label={t('views')}
            options={views.map((v) => ({
              value: v.id,
              label: v.id === pinnedId ? `${v.name} · ${t('pinned')}` : v.name,
            }))}
            {...(viewId ? { value: viewId } : {})}
            onValueChange={chooseView}
          />
        </div>
        <DropdownMenu
          label={t('moreActions')}
          trigger={
            <IconButton label={t('moreActions')} variant="secondary">
              <MoreHorizontal />
            </IconButton>
          }
          items={menu}
        />
        <div className="ms-auto flex items-center gap-2">
          {describe?.access.create ? (
            <Button variant="primary" icon={<Plus />} asChild>
              <Link href={`/${section}/new`} prefetch={false}>
                {t('new')}
              </Link>
            </Button>
          ) : null}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div className="w-72">
          <Input
            type="search"
            aria-label={t('search')}
            placeholder={t('search')}
            prefix={<Search aria-hidden />}
            value={searchText}
            onChange={(e) => {
              setSearchText(e.target.value);
            }}
          />
        </div>
        <Switch
          label={t('myRecords')}
          checked={mine}
          onCheckedChange={(on) => {
            setMine(on);
          }}
        />
        {quickField ? (
          <div className="w-48">
            <Select
              aria-label={quickField.label}
              options={[
                { value: '__any__', label: t('anyValue', { field: quickField.label }) },
                ...picklistOptions(quickField).map((o) => ({ value: o.value, label: o.label })),
              ]}
              value={quick || '__any__'}
              onValueChange={(v) => {
                setQuick(v === '__any__' ? '' : v);
              }}
            />
          </div>
        ) : null}
        <div className="ms-auto flex items-center gap-2">
          {view?.editable && dirty ? (
            <Button size="sm" onClick={() => void saveView()}>
              {t('saveView')}
            </Button>
          ) : null}
          <ColumnChooser
            fields={describe?.fields ?? []}
            selected={currentColumns}
            required={nameField}
            onApply={(next) => {
              setColumnsOverride(next);
            }}
            trigger={
              <Button size="sm" icon={<Columns3 />}>
                {t('columns')}
              </Button>
            }
          />
          <Button
            size="sm"
            variant={split ? 'primary' : 'secondary'}
            icon={<PanelRight />}
            aria-pressed={split}
            onClick={() => {
              setSplit((s) => !s);
              setPreview(null);
            }}
          >
            {t('splitView')}
          </Button>
        </div>
      </div>

      {selected.size > 0 ? (
        <div
          role="region"
          aria-label={tm('selected', { count: selectedCount })}
          className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-selected px-3 py-2"
        >
          <span className="text-body-strong text-fg">
            {allMatching
              ? tm('allMatching', { count: selectedCount })
              : tm('selected', { count: selectedCount })}
          </span>
          {allLoadedSelected && !allMatching && count && count.count > rows.length ? (
            <Button
              size="sm"
              variant="link"
              onClick={() => {
                setAllMatching(true);
              }}
            >
              {tm('selectAllMatching', { count: count.count })}
            </Button>
          ) : null}
          <div className="ms-auto flex gap-2">
            {canMassUpdate ? (
              <Button
                size="sm"
                onClick={() => {
                  setDialog('update');
                }}
              >
                {tm('update')}
              </Button>
            ) : null}
            {describe?.access.delete ? (
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  setDialog('delete');
                }}
              >
                {tm('delete')}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSelected(new Set());
                setAllMatching(false);
              }}
            >
              {tm('clear')}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 gap-3">
        <div className="min-h-0 min-w-0 flex-1">{grid}</div>
        {split ? (
          <RecordPreview
            object={describe}
            row={preview}
            columns={gridColumns.map((c) => c.id)}
            href={preview ? `/${section}/${preview.id}` : null}
            locale={locale}
            timeZone={timeZone}
          />
        ) : null}
      </div>
      <p className="text-caption text-fg-tertiary">{t('keyboardHint')}</p>

      {dialog === 'saveAs' ? (
        <SaveViewDialog
          object={object}
          canShare={canShare}
          draft={{ filter: view?.filter ?? null, columns: currentColumns, sort: currentSort }}
          onClose={(saved) => {
            setDialog(null);
            if (saved) {
              setSortOverride(null);
              setColumnsOverride(null);
              void reloadViews(saved.id);
            }
          }}
        />
      ) : null}
      {dialog === 'update' || dialog === 'delete' ? (
        <MassActionDialog
          kind={dialog}
          object={object}
          target={target}
          count={selectedCount}
          fields={(describe?.fields ?? [])
            .filter((f) => inlineEditable(f) && !f.unique && !f.externalId)
            .sort((a, b) => a.label.localeCompare(b.label))}
          onClose={(changed) => {
            setDialog(null);
            if (changed) {
              setSelected(new Set());
              setAllMatching(false);
              void run(null);
            }
          }}
        />
      ) : null}
    </div>
  );
}
