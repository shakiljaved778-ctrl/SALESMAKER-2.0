'use client';

import { directionOf } from '@sm/i18n';
import { Tooltip } from '@sm/ui';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';

import { useShell } from './app-shell';
import { FOOTER_NAV, MAIN_NAV, navFor, type NavItem } from './nav';

/**
 * Sidebar (§9.7): dark in both themes for a stable frame; 232 px, or 56 px with icons and
 * tooltips when collapsed (`[`).
 */
export function Sidebar({ pathname }: { pathname: string }) {
  const t = useTranslations('shell.nav');
  const { collapsed, toggleSidebar, workspace } = useShell();
  const rtl = directionOf(useLocale()) === 'rtl';
  const active = navFor(pathname)?.key;
  const Toggle = collapsed ? PanelLeftOpen : PanelLeftClose;

  const item = (entry: NavItem) => {
    const Icon = entry.icon;
    const link = (
      <Link
        href={entry.href}
        aria-current={active === entry.key ? 'page' : undefined}
        aria-label={collapsed ? t(entry.key) : undefined}
        className="flex h-8 items-center gap-2.5 rounded-sm px-2.5 text-body-sm text-on-sidebar-muted outline-offset-[-2px] hover:bg-on-sidebar/10 hover:text-on-sidebar aria-[current=page]:bg-on-sidebar/15 aria-[current=page]:text-on-sidebar [&_svg]:size-4 [&_svg]:shrink-0"
      >
        <Icon aria-hidden="true" />
        {collapsed ? null : <span className="truncate">{t(entry.key)}</span>}
      </Link>
    );
    return (
      <li key={entry.key}>
        {collapsed ? (
          <Tooltip content={t(entry.key)} side={rtl ? 'left' : 'right'}>
            {link}
          </Tooltip>
        ) : (
          link
        )}
      </li>
    );
  };

  return (
    <aside
      data-collapsed={collapsed || undefined}
      className="z-[var(--z-sidebar)] flex w-58 shrink-0 flex-col bg-sidebar text-on-sidebar transition-[width] duration-[var(--duration-base)] data-[collapsed]:w-14"
    >
      <div className="flex h-12 shrink-0 items-center gap-2.5 px-4">
        <span
          aria-hidden="true"
          className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-primary text-micro font-semibold text-on-primary"
        >
          {workspace.slice(0, 1).toUpperCase()}
        </span>
        {collapsed ? null : (
          <span className="truncate text-body-sm font-semibold">{workspace}</span>
        )}
      </div>
      <nav
        aria-label={t('label')}
        className="flex min-h-0 flex-1 flex-col justify-between gap-4 overflow-y-auto px-2 pb-2"
      >
        <ul className="flex flex-col gap-0.5">{MAIN_NAV.map(item)}</ul>
        <ul className="flex flex-col gap-0.5">
          {FOOTER_NAV.map(item)}
          <li>
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label={collapsed ? t('expand') : t('collapse')}
              aria-keyshortcuts="["
              className="flex h-8 w-full items-center gap-2.5 rounded-sm px-2.5 text-body-sm text-on-sidebar-muted outline-offset-[-2px] hover:bg-on-sidebar/10 hover:text-on-sidebar [&_svg]:size-4"
            >
              <Toggle aria-hidden="true" data-mirror="" />
              {collapsed ? null : <span className="truncate">{t('collapse')}</span>}
            </button>
          </li>
        </ul>
      </nav>
    </aside>
  );
}
