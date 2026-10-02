import type { ReactNode } from 'react';

import { cn } from '../lib/cn.js';
import { Button } from './button.js';
import { Skeleton } from './feedback.js';

export interface RelatedListRow {
  id: string;
  /** The record name, linked to the record. */
  title: string;
  href?: string | undefined;
  /** Up to four fields from the related list's columns. */
  fields: { label: string; value: ReactNode }[];
  /** Row actions (end side). */
  actions?: ReactNode;
}

export interface RelatedListProps {
  title: string;
  icon?: ReactNode;
  rows: RelatedListRow[];
  /** Total related records; the list shows a preview of `rows`. */
  count?: number | undefined;
  /** Shown when there are no rows (an EmptyState). */
  empty: ReactNode;
  status?: 'ready' | 'loading' | 'error' | 'no-permission';
  error?: ReactNode;
  noPermission?: ReactNode;
  newLabel?: string | undefined;
  onNew?: (() => void) | undefined;
  viewAll?: { label: string; href: string } | undefined;
  /** Accessible text for the count badge, e.g. "12 records". */
  countLabel?: ((count: number) => string) | undefined;
  className?: string;
}

/** Related list card (§9.11 T2, Related tab): header with count and New, preview rows, View all. */
export function RelatedList({
  title,
  icon,
  rows,
  count,
  empty,
  status = 'ready',
  error,
  noPermission,
  newLabel,
  onNew,
  viewAll,
  countLabel,
  className,
}: RelatedListProps) {
  const total = count ?? rows.length;
  let body: ReactNode;
  if (status === 'loading')
    body = (
      <div className="grid gap-3 p-4" aria-busy="true">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  else if (status === 'error') body = <div className="p-4">{error}</div>;
  else if (status === 'no-permission') body = <div className="p-4">{noPermission}</div>;
  else if (rows.length === 0) body = <div className="p-4">{empty}</div>;
  else
    body = (
      <ul className="divide-y divide-line-subtle">
        {rows.map((r) => (
          <li key={r.id} className="group flex items-start gap-3 px-4 py-3 hover:bg-hover">
            <div className="min-w-0 flex-1">
              {r.href ? (
                <a
                  href={r.href}
                  className="block truncate text-body-strong text-link underline-offset-4 hover:underline"
                >
                  {r.title}
                </a>
              ) : (
                <p className="truncate text-body-strong text-fg">{r.title}</p>
              )}
              {r.fields.length ? (
                <dl className="mt-1 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
                  {r.fields.map((f) => (
                    <div key={f.label} className="flex min-w-0 gap-1.5 text-body-sm">
                      <dt className="shrink-0 text-fg-secondary">{f.label}:</dt>
                      <dd className="min-w-0 truncate text-fg">{f.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </div>
            {r.actions ? <div className="shrink-0">{r.actions}</div> : null}
          </li>
        ))}
      </ul>
    );

  return (
    <section
      aria-label={title}
      className={cn('rounded-md border border-line bg-surface shadow-e1', className)}
    >
      <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        {icon ? (
          <span className="grid size-6 place-items-center rounded-sm bg-cat-1-bg text-cat-1-fg [&_svg]:size-3.5">
            {icon}
          </span>
        ) : null}
        <h2 className="truncate text-title-3 text-fg">{title}</h2>
        {status === 'ready' ? (
          <span className="rounded-xs bg-neutral-bg px-1.5 text-micro text-neutral tabular-nums">
            <span aria-hidden={countLabel ? true : undefined}>{total}</span>
            {countLabel ? <span className="sr-only">{countLabel(total)}</span> : null}
          </span>
        ) : null}
        {newLabel && onNew ? (
          <Button size="sm" className="ms-auto" onClick={onNew}>
            {newLabel}
          </Button>
        ) : null}
      </header>
      {body}
      {viewAll && status === 'ready' && rows.length > 0 ? (
        <footer className="border-t border-line px-4 py-2 text-center">
          <a
            href={viewAll.href}
            className="text-body-sm text-link underline-offset-4 hover:underline"
          >
            {viewAll.label}
          </a>
        </footer>
      ) : null}
    </section>
  );
}
