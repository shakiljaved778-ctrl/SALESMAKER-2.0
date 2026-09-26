'use client';

import { EmptyState, Input, Skeleton, cn } from '@sm/ui';
import { Lock, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';

import { useShell } from '../shell/app-shell';
import { SETUP_TREE, setupItemFor } from './setup-nav';

/** True when the signed-in user may open Setup (view_setup, §6.2). */
export function useCanViewSetup(): boolean | null {
  const { user } = useShell();
  return user ? user.permissions.includes('view_setup') : null;
}

export function useHasPermission(name: string): boolean {
  const { user } = useShell();
  return Boolean(user?.permissions.includes(name));
}

/**
 * Setup layout (T5): a searchable tree on the start side, the page on the end side. Without
 * view_setup the whole area answers "forbidden" — the sidebar hides it, and a direct URL lands here.
 */
export function SetupShell({ children }: { children: ReactNode }) {
  const t = useTranslations('setup');
  const pathname = usePathname();
  const allowed = useCanViewSetup();
  const [filter, setFilter] = useState('');
  const active = setupItemFor(pathname);

  if (allowed === null) {
    return (
      <div aria-busy="true" className="p-[var(--page-padding)]">
        <Skeleton className="h-8 w-64" />
      </div>
    );
  }
  if (!allowed) {
    return (
      <div className="p-[var(--page-padding)]">
        <h1 className="sr-only">{t('forbidden.title')}</h1>
        <EmptyState
          icon={<Lock />}
          title={t('forbidden.title')}
          description={t('forbidden.body')}
          className="mt-16"
        />
      </div>
    );
  }

  const needle = filter.trim().toLowerCase();
  const groups = SETUP_TREE.map((g) => ({
    ...g,
    items: g.items.filter(
      (i) =>
        !needle ||
        t(`items.${i.key}`).toLowerCase().includes(needle) ||
        t(`groups.${g.key}`).toLowerCase().includes(needle),
    ),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="flex min-h-full">
      <nav
        aria-label={t('title')}
        className="flex w-60 shrink-0 flex-col gap-3 border-e border-line bg-surface p-3"
      >
        <p className="px-2 text-title-3 text-fg">{t('title')}</p>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute start-2 top-1/2 size-4 -translate-y-1/2 text-fg-secondary"
          />
          <Input
            type="search"
            aria-label={t('search')}
            placeholder={t('search')}
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
            }}
            className="ps-8"
          />
        </div>
        {groups.length === 0 ? (
          <p role="status" className="px-2 text-body-sm text-fg-secondary">
            {t('noMatches')}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {groups.map((g) => (
              <li key={g.key}>
                <p className="px-2 pb-1 text-caption text-fg-secondary">{t(`groups.${g.key}`)}</p>
                <ul className="flex flex-col gap-0.5">
                  {g.items.map((i) => (
                    <li key={i.key}>
                      <Link
                        href={i.href}
                        aria-current={active?.key === i.key ? 'page' : undefined}
                        className={cn(
                          'flex h-8 items-center rounded-sm px-2 text-body-sm text-fg hover:bg-hover',
                          'aria-[current=page]:bg-subtle aria-[current=page]:font-medium',
                        )}
                      >
                        {t(`items.${i.key}`)}
                      </Link>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </nav>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Setup page header (T5): title, one-line description and the page's primary actions. */
export function SetupHeader({
  title,
  description,
  actions,
  breadcrumb,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  breadcrumb?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line px-[var(--page-padding)] py-5">
      <div className="flex min-w-0 flex-col gap-1">
        {breadcrumb}
        <h1 className="truncate text-title-2 text-fg">{title}</h1>
        {description ? <p className="text-body-sm text-fg-secondary">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
