'use client';

import {
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnOrderState,
  type ColumnPinningState,
  type ColumnSizingState,
  type SortingState,
  type VisibilityState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, MoreHorizontal } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { cn } from '../lib/cn.js';
import { Button } from './button.js';
import { Skeleton } from './feedback.js';
import { DropdownMenu, type MenuEntry } from './menu.js';

/** Every user-facing string the grid shows (golden rule 5: callers pass translated text). */
export interface DataGridLabels {
  selectAll: string;
  selectRow: (rowLabel: string) => string;
  sortAscending: string;
  sortDescending: string;
  clearSort: string;
  columnMenu: (column: string) => string;
  pinColumn: string;
  unpinColumn: string;
  hideColumn: string;
  moveLeft: string;
  moveRight: string;
  resizeColumn: (column: string) => string;
  expandGroup: (group: string) => string;
  collapseGroup: (group: string) => string;
  loadMore: string;
  loading: string;
  rowActions: string;
}

export interface DataGridColumn<T> {
  id: string;
  header: string;
  /** The value the column sorts and edits by. */
  value: (row: T) => unknown;
  /** How the value shows (default: the value as text). Field renderers plug in here (T18). */
  cell?: (row: T) => ReactNode;
  width?: number;
  minWidth?: number;
  sortable?: boolean;
  /** Numbers and money line up at the end (§9.3). */
  align?: 'start' | 'end';
  /** Whether this cell may be edited for this row (FLS-aware editors decide upstream). */
  editable?: boolean | ((row: T) => boolean);
  /** Aggregate shown on group header rows, e.g. a sum of amounts. */
  aggregate?: (rows: readonly T[]) => ReactNode;
  /** Columns that cannot be hidden (the record name). */
  required?: boolean;
}

export interface DataGridLayout {
  order?: ColumnOrderState;
  hidden?: string[];
  pinned?: string[];
  sizes?: ColumnSizingState;
}

export type DataGridStatus = 'ready' | 'loading' | 'error' | 'no-permission';

export interface DataGridProps<T> {
  /** Accessible name of the grid, e.g. "Leads". */
  label: string;
  rows: readonly T[];
  rowId: (row: T) => string;
  /** A short name of the row for screen readers ("Maya Chen"). */
  rowLabel: (row: T) => string;
  columns: readonly DataGridColumn<T>[];
  labels: DataGridLabels;
  status?: DataGridStatus;
  /** Shown when there are no rows and nothing is filtered (teaches the next step). */
  empty: ReactNode;
  /** Shown when filters or search leave no rows. */
  noResults?: ReactNode;
  filtered?: boolean;
  /** Shown with status "error" (e.g. a Banner with a retry action). */
  error?: ReactNode;
  /** Shown with status "no-permission". */
  noPermission?: ReactNode;
  /** Server-side sorting (keyset lists): the grid reports changes and does not sort itself. */
  sorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;
  /** Checkbox selection (with shift-click ranges). */
  selected?: ReadonlySet<string>;
  onSelectedChange?: (selected: Set<string>) => void;
  layout?: DataGridLayout;
  onLayoutChange?: (layout: DataGridLayout) => void;
  /** Group rows under collapsible headers. */
  groupBy?: (row: T) => string;
  groupLabel?: (key: string, rows: readonly T[]) => string;
  /** Actions at the end of a row, shown on hover and focus. */
  rowActions?: (row: T) => ReactNode;
  /** Enter on a row's first cell (or a double-click) opens the record. */
  onRowOpen?: (row: T) => void;
  /**
   * Object-list keys (§9.11 T1): J/K move down/up, X selects, E edits the focused cell, and Enter
   * always opens the record (instead of editing).
   */
  listKeys?: boolean;
  /** The row that has keyboard focus or was last clicked (e.g. for a split view). */
  onActiveRowChange?: (row: T | null) => void;
  /** Inline editing: render an editor; call `done(value)` to save or `done()` to cancel. */
  renderEditor?: (row: T, column: DataGridColumn<T>, done: (value?: unknown) => void) => ReactNode;
  onCellEdit?: (row: T, column: DataGridColumn<T>, value: unknown) => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  /** Height of the scroll area (the grid fills it). */
  height?: number | string;
  /** Direction; by default the grid follows its surroundings (the document's `dir`). */
  dir?: 'ltr' | 'rtl';
  className?: string;
}

/** Rows are virtualised beyond this many items; fewer render plainly (and testably). */
export const VIRTUALIZE_FROM = 100;
const ROW_HEIGHT = 36;
const SELECT_COL = '__select';
const ACTIONS_COL = '__actions';

type Item<T> =
  | { kind: 'group'; key: string; label: string; rows: T[]; collapsed: boolean }
  | { kind: 'row'; row: T; id: string };

const textOf = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value);
  return JSON.stringify(value);
};

/**
 * The data grid (§9.10, "the most important component"): sticky header and first column,
 * resize, reorder, pin and hide, multi-sort (shift), checkbox selection with ranges, keyboard
 * grid navigation (arrows, Home/End, PageUp/Down, Enter edits or opens, Esc cancels, Space
 * selects), grouped rows with aggregates, "load more", and the empty, no-results, error and
 * no-permission states. ARIA grid semantics with row and column indices throughout.
 */
export function DataGrid<T>(props: DataGridProps<T>) {
  const {
    label,
    rows,
    rowId,
    rowLabel,
    columns,
    labels,
    status = 'ready',
    selected,
    onSelectedChange,
    layout,
    onLayoutChange,
    groupBy,
    groupLabel,
    rowActions,
    onRowOpen,
    listKeys = false,
    onActiveRowChange,
    renderEditor,
    onCellEdit,
  } = props;
  const selectable = Boolean(selected && onSelectedChange);
  const serverSort = Boolean(props.onSortingChange);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [inheritedDir, setInheritedDir] = useState<'ltr' | 'rtl'>('ltr');
  useLayoutEffect(() => {
    if (props.dir || !scrollRef.current) return;
    const found = getComputedStyle(scrollRef.current).direction === 'rtl' ? 'rtl' : 'ltr';
    setInheritedDir((prev) => (prev === found ? prev : found));
  });
  const dir = props.dir ?? inheritedDir;

  // ── Column state (controlled by `layout` when given) ───────────────────────────────────
  const [localSorting, setLocalSorting] = useState<SortingState>([]);
  const sorting = props.sorting ?? localSorting;
  const [localLayout, setLocalLayout] = useState<DataGridLayout>({});
  const current = layout ?? localLayout;
  const setLayout = useCallback(
    (next: DataGridLayout) => {
      if (onLayoutChange) onLayoutChange(next);
      else setLocalLayout(next);
    },
    [onLayoutChange],
  );
  const visibility: VisibilityState = Object.fromEntries(
    (current.hidden ?? []).map((id) => [id, false]),
  );
  // The first data column is always pinned (sticky), with any the user pinned after it.
  const firstId = (current.order ?? columns.map((c) => c.id)).find(
    (id) => !(current.hidden ?? []).includes(id),
  );
  // TanStack names the pinning sides `left` and `right` in reading order; the grid renders them
  // with logical (inline-start/end) offsets, so RTL works. Built from entries because those key
  // names are not layout properties.
  const pinning = Object.fromEntries([
    [
      'left',
      [
        ...(selectable ? [SELECT_COL] : []),
        ...new Set([...(firstId ? [firstId] : []), ...(current.pinned ?? [])]),
      ],
    ],
    ['right', rowActions ? [ACTIONS_COL] : []],
  ]) as ColumnPinningState;

  const defs = useMemo<ColumnDef<T>[]>(
    () => [
      ...(selectable
        ? [
            {
              id: SELECT_COL,
              size: 40,
              enableResizing: false,
              enableSorting: false,
            } satisfies ColumnDef<T>,
          ]
        : []),
      ...columns.map((c): ColumnDef<T> => ({
        id: c.id,
        header: c.header,
        accessorFn: (row) => c.value(row),
        size: c.width ?? 160,
        minSize: c.minWidth ?? 64,
        enableSorting: c.sortable ?? false,
        sortingFn: 'alphanumeric',
        cell: (ctx) => (c.cell ? c.cell(ctx.row.original) : textOf(ctx.getValue())),
      })),
      ...(rowActions
        ? [
            {
              id: ACTIONS_COL,
              size: 56,
              enableResizing: false,
              enableSorting: false,
            } satisfies ColumnDef<T>,
          ]
        : []),
    ],
    [columns, selectable, rowActions],
  );

  const table = useReactTable<T>({
    data: rows as T[],
    columns: defs,
    getRowId: (row) => rowId(row),
    getCoreRowModel: getCoreRowModel(),
    ...(serverSort ? { manualSorting: true } : { getSortedRowModel: getSortedRowModel() }),
    enableMultiSort: true,
    // Ascending first for every type (TanStack starts numbers descending).
    sortDescFirst: false,
    isMultiSortEvent: (e) => (e as { shiftKey?: boolean }).shiftKey === true,
    columnResizeMode: 'onChange',
    columnResizeDirection: dir,
    state: {
      sorting,
      columnVisibility: visibility,
      columnPinning: pinning,
      columnSizing: current.sizes ?? {},
      ...(current.order
        ? { columnOrder: [...(selectable ? [SELECT_COL] : []), ...current.order] }
        : {}),
    },
    onSortingChange: (updater) => {
      const next = typeof updater === 'function' ? updater(sorting) : updater;
      if (props.onSortingChange) props.onSortingChange(next);
      else setLocalSorting(next);
    },
    onColumnSizingChange: (updater) => {
      const next = typeof updater === 'function' ? updater(current.sizes ?? {}) : updater;
      setLayout({ ...current, sizes: next });
    },
  });

  const leaf = table.getVisibleLeafColumns();
  const ordered = [
    ...leaf.filter((c) => c.getIsPinned() === 'left'),
    ...leaf.filter((c) => !c.getIsPinned()),
    ...leaf.filter((c) => c.getIsPinned() === 'right'),
  ];
  const columnById = new Map(columns.map((c) => [c.id, c]));
  const dataOrder = (current.order ?? columns.map((c) => c.id)).filter((id) => columnById.has(id));

  // ── Rows and groups ─────────────────────────────────────────────────────────────────────
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const sortedRows = table.getRowModel().rows.map((r) => r.original);
  const items = useMemo<Item<T>[]>(() => {
    if (!groupBy) return sortedRows.map((row) => ({ kind: 'row', row, id: rowId(row) }));
    const groups = new Map<string, T[]>();
    for (const row of sortedRows) {
      const key = groupBy(row);
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }
    return [...groups].flatMap(([key, list]): Item<T>[] => [
      {
        kind: 'group',
        key,
        label: groupLabel ? groupLabel(key, list) : key,
        rows: list,
        collapsed: collapsed.has(key),
      },
      ...(collapsed.has(key)
        ? []
        : list.map((row): Item<T> => ({ kind: 'row', row, id: rowId(row) }))),
    ]);
  }, [sortedRows, groupBy, groupLabel, collapsed, rowId]);

  // ── Selection with shift-click ranges ──────────────────────────────────────────────────
  const anchor = useRef<string | null>(null);
  const rowIds = items.flatMap((i) => (i.kind === 'row' ? [i.id] : []));
  const toggle = (id: string, range: boolean) => {
    if (!selected || !onSelectedChange) return;
    const next = new Set(selected);
    const on = !selected.has(id);
    if (range && anchor.current) {
      const a = rowIds.indexOf(anchor.current);
      const b = rowIds.indexOf(id);
      if (a >= 0 && b >= 0)
        for (const rid of rowIds.slice(Math.min(a, b), Math.max(a, b) + 1))
          if (on) next.add(rid);
          else next.delete(rid);
    } else if (on) next.add(id);
    else next.delete(id);
    anchor.current = id;
    onSelectedChange(next);
  };
  const allSelected = rowIds.length > 0 && rowIds.every((id) => selected?.has(id));
  const someSelected = !allSelected && rowIds.some((id) => selected?.has(id));

  // ── Keyboard navigation (roving focus over cells) ───────────────────────────────────────
  const [active, setActive] = useState<{ row: number; col: number }>({ row: 0, col: 0 });
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(null);
  const totalRows = items.length + 1; // the header row is row 1
  const virtual = items.length > VIRTUALIZE_FROM;
  const fallbackHeight = typeof props.height === 'number' ? props.height : 640;
  const virtualizer = useVirtualizer({
    count: virtual ? items.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    initialRect: { width: 1024, height: fallbackHeight },
    // A scroll area measured at 0 px (not laid out yet, or jsdom) falls back to its intended
    // height, so the first window of rows renders.
    observeElementRect: (instance, report) => {
      const el = instance.scrollElement;
      if (!el) return undefined;
      const measure = () => {
        const r = el.getBoundingClientRect();
        report({ width: r.width || 1024, height: r.height || fallbackHeight });
      };
      measure();
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      return () => {
        observer.disconnect();
      };
    },
  });

  const focusCell = useCallback((row: number, col: number) => {
    const root = scrollRef.current;
    if (!root) return;
    const cell = root.querySelector<HTMLElement>(`[data-cell="${String(row)}:${String(col)}"]`);
    cell?.focus();
  }, []);
  // Focus follows the active cell only after a keyboard move (never steals focus otherwise,
  // e.g. from a menu returning focus to its trigger).
  const keyboardMove = useRef(false);
  useEffect(() => {
    if (!keyboardMove.current || editing) return;
    keyboardMove.current = false;
    focusCell(active.row, active.col);
  }, [active, editing, focusCell]);
  // Report the active row only when it changes to another record.
  const reportedRow = useRef<string | null>(null);
  useEffect(() => {
    if (!onActiveRowChange) return;
    const item = active.row > 0 ? items[active.row - 1] : undefined;
    const id = item?.kind === 'row' ? item.id : null;
    if (id === reportedRow.current) return;
    reportedRow.current = id;
    onActiveRowChange(item?.kind === 'row' ? item.row : null);
  }, [active.row, items, onActiveRowChange]);
  const activate = (row: number, col: number) => {
    setActive((prev) => (prev.row === row && prev.col === col ? prev : { row, col }));
  };

  const move = (row: number, col: number) => {
    const r = Math.max(0, Math.min(totalRows - 1, row));
    const c = Math.max(0, Math.min(ordered.length - 1, col));
    if (virtual && r > 0) virtualizer.scrollToIndex(r - 1, { align: 'auto' });
    keyboardMove.current = true;
    setActive({ row: r, col: c });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setEditing(null);
      }
      return;
    }
    const { row, col } = active;
    const rtl = dir === 'rtl';
    const keys: Record<string, () => void> = {
      ArrowDown: () => {
        move(row + 1, col);
      },
      ArrowUp: () => {
        move(row - 1, col);
      },
      ArrowRight: () => {
        move(row, col + (rtl ? -1 : 1));
      },
      ArrowLeft: () => {
        move(row, col + (rtl ? 1 : -1));
      },
      Home: () => {
        if (e.ctrlKey) move(0, 0);
        else move(row, 0);
      },
      End: () => {
        if (e.ctrlKey) move(totalRows - 1, ordered.length - 1);
        else move(row, ordered.length - 1);
      },
      PageDown: () => {
        move(row + 10, col);
      },
      PageUp: () => {
        move(row - 10, col);
      },
    };
    const listKey = listKeys && !e.ctrlKey && !e.metaKey && !e.altKey;
    const alias = listKey ? { j: 'ArrowDown', k: 'ArrowUp' }[e.key] : undefined;
    const action = keys[alias ?? e.key];
    if (action) {
      e.preventDefault();
      action();
      return;
    }
    const item = row > 0 ? items[row - 1] : undefined;
    const column = ordered[col];
    if ((e.key === ' ' || (listKey && e.key === 'x')) && item?.kind === 'row' && selectable) {
      e.preventDefault();
      toggle(item.id, e.shiftKey);
      return;
    }
    if (listKey && e.key === 'e' && item?.kind === 'row' && column) {
      const def = columnById.get(column.id);
      const editable =
        def &&
        renderEditor &&
        (typeof def.editable === 'function' ? def.editable(item.row) : def.editable);
      if (editable) {
        e.preventDefault();
        setEditing({ row, col });
      }
      return;
    }
    if (e.key === 'Enter') {
      if (row === 0 && column?.getCanSort()) {
        e.preventDefault();
        column.toggleSorting(undefined, e.shiftKey);
        return;
      }
      if (item?.kind === 'group') {
        e.preventDefault();
        toggleGroup(item.key);
        return;
      }
      if (item?.kind !== 'row' || !column) return;
      const def = columnById.get(column.id);
      const editable =
        def &&
        renderEditor &&
        (typeof def.editable === 'function' ? def.editable(item.row) : def.editable);
      e.preventDefault();
      if (editable && !listKeys) setEditing({ row, col });
      else if (onRowOpen) onRowOpen(item.row);
    }
  };

  const toggleGroup = (key: string) => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCollapsed(next);
  };

  // ── Column menu: sort, pin, hide, move ─────────────────────────────────────────────────
  const moveColumn = (id: string, by: number) => {
    const order = [...dataOrder];
    const from = order.indexOf(id);
    const to = from + by;
    if (from < 0 || to < 0 || to >= order.length) return;
    order.splice(to, 0, ...order.splice(from, 1));
    setLayout({ ...current, order });
  };
  const columnMenu = (id: string): MenuEntry[] => {
    const col = table.getColumn(id);
    const def = columnById.get(id);
    const pinned = (current.pinned ?? []).includes(id);
    const index = dataOrder.indexOf(id);
    return [
      ...(col?.getCanSort()
        ? [
            {
              type: 'item' as const,
              label: labels.sortAscending,
              onSelect: () => {
                col.toggleSorting(false);
              },
            },
            {
              type: 'item' as const,
              label: labels.sortDescending,
              onSelect: () => {
                col.toggleSorting(true);
              },
            },
            {
              type: 'item' as const,
              label: labels.clearSort,
              onSelect: () => {
                col.clearSorting();
              },
            },
            { type: 'separator' as const },
          ]
        : []),
      {
        type: 'item' as const,
        label: pinned ? labels.unpinColumn : labels.pinColumn,
        onSelect: () => {
          setLayout({
            ...current,
            pinned: pinned
              ? (current.pinned ?? []).filter((p) => p !== id)
              : [...(current.pinned ?? []), id],
          });
        },
      },
      {
        type: 'item' as const,
        label: labels.moveLeft,
        disabled: index <= 0,
        onSelect: () => {
          moveColumn(id, -1);
        },
      },
      {
        type: 'item' as const,
        label: labels.moveRight,
        disabled: index < 0 || index >= dataOrder.length - 1,
        onSelect: () => {
          moveColumn(id, 1);
        },
      },
      ...(def?.required
        ? []
        : [
            {
              type: 'item' as const,
              label: labels.hideColumn,
              onSelect: () => {
                setLayout({ ...current, hidden: [...(current.hidden ?? []), id] });
              },
            },
          ]),
    ];
  };

  // Drag a header onto another to reorder (pointer users; the menu is the keyboard path).
  const dragging = useRef<string | null>(null);

  // ── Rendering ───────────────────────────────────────────────────────────────────────────
  const offsets = new Map<string, { start?: number; end?: number }>();
  {
    let start = 0;
    for (const c of ordered.filter((x) => x.getIsPinned() === 'left')) {
      offsets.set(c.id, { start });
      start += c.getSize();
    }
    let end = 0;
    for (const c of [...ordered.filter((x) => x.getIsPinned() === 'right')].reverse()) {
      offsets.set(c.id, { end });
      end += c.getSize();
    }
  }
  const width = ordered.reduce((sum, c) => sum + c.getSize(), 0);
  // In a grid wider than its columns, end-pinned columns (row actions) sit at the far edge.
  const firstEndId = ordered.find((c) => c.getIsPinned() === 'right')?.id;
  const atEnd = (id: string) => (id === firstEndId ? 'ms-auto' : '');
  const stickyStyle = (id: string) => {
    const o = offsets.get(id);
    if (!o) return {};
    return o.start !== undefined ? { insetInlineStart: o.start } : { insetInlineEnd: o.end };
  };
  const cellBase = 'flex h-full items-center px-3 text-cell';
  const pinnedClass = (id: string) =>
    offsets.has(id)
      ? 'sticky z-10 bg-surface group-hover:bg-hover group-data-[selected=true]:bg-selected'
      : '';

  const tabFor = (row: number, col: number) => (active.row === row && active.col === col ? 0 : -1);

  const header = (
    <div
      role="row"
      aria-rowindex={1}
      className="sticky top-0 z-20 flex h-(--row-height) min-w-full border-b border-line bg-subtle"
      style={{ width }}
    >
      {ordered.map((col, ci) => {
        const sorted = col.getIsSorted();
        const def = columnById.get(col.id);
        const sortIndex = sorting.length > 1 ? col.getSortIndex() : -1;
        return (
          <div
            key={col.id}
            role="columnheader"
            aria-colindex={ci + 1}
            aria-sort={
              sorted === 'asc'
                ? 'ascending'
                : sorted === 'desc'
                  ? 'descending'
                  : col.getCanSort()
                    ? 'none'
                    : undefined
            }
            data-cell={`0:${String(ci)}`}
            tabIndex={tabFor(0, ci)}
            onFocus={() => {
              activate(0, ci);
            }}
            draggable={Boolean(def)}
            onDragStart={() => {
              dragging.current = col.id;
            }}
            onDragOver={(e) => {
              if (def && dragging.current) e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              const from = dragging.current;
              dragging.current = null;
              if (!from || from === col.id) return;
              const order = dataOrder.filter((x) => x !== from);
              order.splice(order.indexOf(col.id), 0, from);
              setLayout({ ...current, order });
            }}
            className={cn(
              'group/header relative flex h-full shrink-0 items-center gap-1 ps-3 pe-1 text-label font-semibold text-fg-secondary outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset',
              def?.align === 'end' && 'justify-end',
              offsets.has(col.id) && 'sticky z-30 bg-subtle',
              atEnd(col.id),
            )}
            style={{ width: col.getSize(), ...stickyStyle(col.id) }}
          >
            {col.id === SELECT_COL ? (
              <input
                type="checkbox"
                aria-label={labels.selectAll}
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someSelected;
                }}
                onChange={() => onSelectedChange?.(allSelected ? new Set() : new Set(rowIds))}
                className="size-4 accent-(--color-primary)"
              />
            ) : col.id === ACTIONS_COL ? (
              <span className="sr-only">{labels.rowActions}</span>
            ) : (
              <>
                <button
                  type="button"
                  tabIndex={-1}
                  disabled={!col.getCanSort()}
                  onClick={(e) => {
                    col.toggleSorting(undefined, e.shiftKey);
                  }}
                  className="flex min-w-0 items-center gap-1 truncate text-start enabled:hover:text-fg"
                >
                  <span className="truncate">{def?.header}</span>
                  {sorted === 'asc' ? (
                    <ArrowUp aria-hidden="true" className="size-3.5 shrink-0" />
                  ) : null}
                  {sorted === 'desc' ? (
                    <ArrowDown aria-hidden="true" className="size-3.5 shrink-0" />
                  ) : null}
                  {sortIndex >= 0 ? (
                    <span className="text-caption text-fg-tertiary">{sortIndex + 1}</span>
                  ) : null}
                </button>
                <span className="ms-auto opacity-0 group-hover/header:opacity-100 group-focus-within/header:opacity-100">
                  <DropdownMenu
                    trigger={
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-label={labels.columnMenu(def?.header ?? col.id)}
                        className="rounded-xs p-0.5 text-fg-secondary hover:bg-hover"
                      >
                        <MoreHorizontal aria-hidden="true" className="size-4" />
                      </button>
                    }
                    items={columnMenu(col.id)}
                  />
                </span>
                {col.getCanResize() ? (
                  <span
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={labels.resizeColumn(def?.header ?? col.id)}
                    aria-valuenow={col.getSize()}
                    tabIndex={-1}
                    onMouseDown={table
                      .getHeaderGroups()[0]
                      ?.headers.find((h) => h.column.id === col.id)
                      ?.getResizeHandler()}
                    onTouchStart={table
                      .getHeaderGroups()[0]
                      ?.headers.find((h) => h.column.id === col.id)
                      ?.getResizeHandler()}
                    onKeyDown={(e) => {
                      const step = e.key === 'ArrowRight' ? 16 : e.key === 'ArrowLeft' ? -16 : 0;
                      if (!step) return;
                      e.preventDefault();
                      e.stopPropagation();
                      const delta = dir === 'rtl' ? -step : step;
                      setLayout({
                        ...current,
                        sizes: {
                          ...current.sizes,
                          [col.id]: Math.max(col.columnDef.minSize ?? 64, col.getSize() + delta),
                        },
                      });
                    }}
                    className="absolute inset-y-1 end-0 w-1 cursor-col-resize rounded-full hover:bg-line-strong focus-visible:bg-focus"
                  />
                ) : null}
              </>
            )}
          </div>
        );
      })}
    </div>
  );

  const renderItem = (item: Item<T>, index: number, style?: { transform: string }) => {
    const rowIndex = index + 2; // aria-rowindex: header is 1
    const r = index + 1; // keyboard row (header is 0)
    if (item.kind === 'group') {
      const expanded = !item.collapsed;
      return (
        <div
          key={`g:${item.key}`}
          role="row"
          aria-rowindex={rowIndex}
          data-group={item.key}
          className="flex h-(--row-height) min-w-full border-b border-line-subtle bg-subtle"
          style={{ width, ...(style ? { position: 'absolute', top: 0, ...style } : {}) }}
        >
          <div
            role="gridcell"
            aria-colindex={1}
            aria-colspan={ordered.length}
            data-cell={`${String(r)}:0`}
            tabIndex={tabFor(r, 0)}
            onFocus={() => {
              activate(r, 0);
            }}
            className={cn(
              cellBase,
              'sticky start-0 w-full gap-2 font-semibold outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset',
            )}
          >
            <button
              type="button"
              tabIndex={-1}
              aria-expanded={expanded}
              aria-label={
                expanded ? labels.collapseGroup(item.label) : labels.expandGroup(item.label)
              }
              onClick={() => {
                toggleGroup(item.key);
              }}
              className="rounded-xs text-fg-secondary hover:text-fg"
            >
              {expanded ? (
                <ChevronDown aria-hidden="true" className="size-4" />
              ) : (
                <ChevronRight aria-hidden="true" className="size-4 rtl:rotate-180" />
              )}
            </button>
            <span>{item.label}</span>
            <span className="text-fg-tertiary">{item.rows.length}</span>
            {columns
              .filter((c) => c.aggregate)
              .map((c) => (
                <span key={c.id} className="ms-4 text-fg-secondary">
                  {c.header}: {c.aggregate?.(item.rows)}
                </span>
              ))}
          </div>
        </div>
      );
    }
    const isSelected = selected?.has(item.id) ?? false;
    return (
      <div
        key={item.id}
        role="row"
        aria-rowindex={rowIndex}
        aria-selected={selectable ? isSelected : undefined}
        data-selected={isSelected}
        onDoubleClick={() => onRowOpen?.(item.row)}
        className="group flex h-(--row-height) min-w-full border-b border-line-subtle bg-surface hover:bg-hover data-[selected=true]:bg-selected"
        style={{ width, ...(style ? { position: 'absolute', top: 0, ...style } : {}) }}
      >
        {ordered.map((col, ci) => {
          const def = columnById.get(col.id);
          const isEditing = editing?.row === r && editing.col === ci;
          return (
            <div
              key={col.id}
              role="gridcell"
              aria-colindex={ci + 1}
              data-cell={`${String(r)}:${String(ci)}`}
              tabIndex={tabFor(r, ci)}
              onFocus={() => {
                activate(r, ci);
              }}
              className={cn(
                cellBase,
                'min-w-0 shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset',
                def?.align === 'end' && 'justify-end tabular-nums',
                pinnedClass(col.id),
                atEnd(col.id),
              )}
              style={{ width: col.getSize(), ...stickyStyle(col.id) }}
            >
              {col.id === SELECT_COL ? (
                <input
                  type="checkbox"
                  tabIndex={-1}
                  aria-label={labels.selectRow(rowLabel(item.row))}
                  checked={isSelected}
                  onClick={(e) => {
                    e.preventDefault();
                    toggle(item.id, e.shiftKey);
                  }}
                  onChange={() => undefined}
                  className="size-4 accent-(--color-primary)"
                />
              ) : col.id === ACTIONS_COL ? (
                <div className="flex opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                  {rowActions?.(item.row)}
                </div>
              ) : isEditing && def && renderEditor ? (
                renderEditor(item.row, def, (value) => {
                  setEditing(null);
                  if (value !== undefined) onCellEdit?.(item.row, def, value);
                  focusCell(r, ci);
                })
              ) : (
                <span className="truncate">
                  {def?.cell ? def.cell(item.row) : textOf(def?.value(item.row))}
                </span>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  let body: ReactNode;
  if (status === 'loading')
    body = (
      <div aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex gap-3 border-b border-line-subtle px-3 py-2.5">
            <Skeleton shape="text" className="w-1/4" />
            <Skeleton shape="text" className="w-1/3" />
            <Skeleton shape="text" className="w-1/5" />
          </div>
        ))}
      </div>
    );
  else if (status === 'error') body = <div className="p-4">{props.error}</div>;
  else if (status === 'no-permission') body = <div className="p-4">{props.noPermission}</div>;
  else if (rows.length === 0)
    body = props.filtered ? (props.noResults ?? props.empty) : props.empty;
  else if (virtual)
    body = (
      <div className="relative" style={{ height: virtualizer.getTotalSize(), width }}>
        {virtualizer.getVirtualItems().map((v) => {
          const item = items[v.index];
          return item
            ? renderItem(item, v.index, { transform: `translateY(${String(v.start)}px)` })
            : null;
        })}
      </div>
    );
  else body = items.map((item, i) => renderItem(item, i));

  const showRows = status === 'ready' && rows.length > 0;
  return (
    <div
      className={cn(
        'flex min-h-0 flex-col rounded-md border border-line bg-surface',
        props.className,
      )}
      dir={props.dir}
      // The height belongs to the whole grid; the scroll area fills what the header and footer leave.
      style={{ height: props.height }}
    >
      <div
        ref={scrollRef}
        role={showRows ? 'grid' : 'region'}
        aria-label={label}
        aria-busy={status === 'loading' || undefined}
        aria-rowcount={showRows ? totalRows : undefined}
        aria-colcount={showRows ? ordered.length : undefined}
        aria-multiselectable={showRows && selectable ? true : undefined}
        onKeyDown={showRows ? onKeyDown : undefined}
        className="relative min-h-0 flex-1 overflow-auto"
      >
        {showRows ? header : null}
        {status === 'loading' ? <span className="sr-only">{labels.loading}</span> : null}
        {body}
      </div>
      {props.hasMore && status === 'ready' ? (
        <div className="flex justify-center border-t border-line-subtle p-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={props.onLoadMore}
            loading={props.loadingMore}
          >
            {labels.loadMore}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
