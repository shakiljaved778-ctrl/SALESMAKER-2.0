'use client';

import { Avatar, Button, DropdownMenu, IconButton, Kbd, Popover } from '@sm/ui';
import { Bell, ChevronRight, Plus, Search, Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { applyDisplay } from '../../lib/display';
import { DENSITIES, THEMES, type Density, type Theme } from '../../lib/preferences';
import { useShell } from './app-shell';
import { navFor } from './nav';

const THEME_LABEL = { light: 'themeLight', dark: 'themeDark', system: 'themeSystem' } as const;
const DENSITY_LABEL = {
  comfortable: 'densityComfortable',
  default: 'densityDefault',
  compact: 'densityCompact',
} as const;

/** ⌘ on Apple platforms, Ctrl elsewhere; decided after hydration so server and client agree. */
function useModKey(): string {
  const [mod, setMod] = useState('Ctrl');
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.userAgent)) setMod('⌘');
  }, []);
  return mod;
}

/** Top bar (§9.7): breadcrumbs, ⌘K search, + New, AI, notifications, avatar menu. */
export function TopBar({ pathname }: { pathname: string }) {
  const t = useTranslations('shell');
  const tc = useTranslations('common');
  const router = useRouter();
  const mod = useModKey();
  const { user, workspace, openPalette, openShortcuts, openAssistant, signOut } = useShell();
  const section = navFor(pathname);
  const [display, setDisplay] = useState<{ theme: Theme; density: Density }>({
    theme: 'system',
    density: 'default',
  });
  useEffect(() => {
    const root = document.documentElement.dataset;
    setDisplay({
      theme: (THEMES as readonly string[]).includes(root.theme ?? '')
        ? (root.theme as Theme)
        : 'system',
      density: (DENSITIES as readonly string[]).includes(root.density ?? '')
        ? (root.density as Density)
        : 'default',
    });
  }, [user]);

  const change = (next: { theme?: Theme; density?: Density }) => {
    applyDisplay(next);
    setDisplay((d) => ({ ...d, ...next }));
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
      <nav aria-label={t('topBar.breadcrumbs')} className="min-w-0 flex-1">
        <ol className="flex items-center gap-1.5 text-body-sm text-fg-secondary [&_svg]:size-3.5">
          <li className="truncate">{workspace}</li>
          {section ? (
            <>
              <li aria-hidden="true">
                <ChevronRight data-mirror="" />
              </li>
              <li aria-current="page" className="truncate font-medium text-fg">
                {t(`nav.${section.key}`)}
              </li>
            </>
          ) : null}
        </ol>
      </nav>

      <button
        type="button"
        onClick={openPalette}
        aria-keyshortcuts="Meta+K Control+K"
        className="hidden h-8 w-64 items-center gap-2 rounded-sm border border-line bg-subtle px-2.5 text-body-sm text-fg-secondary hover:border-line-strong md:flex [&_svg]:size-4"
      >
        <Search aria-hidden="true" />
        <span className="flex-1 truncate text-start">{t('topBar.search')}</span>
        <Kbd>{`${mod} K`}</Kbd>
      </button>
      <IconButton
        label={t('topBar.search')}
        variant="ghost"
        className="md:hidden"
        onClick={openPalette}
      >
        <Search aria-hidden="true" />
      </IconButton>

      <DropdownMenu
        modal={false}
        label={t('topBar.new')}
        trigger={
          <Button variant="secondary" size="sm" icon={<Plus aria-hidden="true" />}>
            {t('topBar.new')}
          </Button>
        }
        items={(['lead', 'account', 'contact', 'opportunity', 'task'] as const).map((kind) => ({
          type: 'item' as const,
          label: t(`new.${kind}`),
          onSelect: () => {
            router.push(
              kind === 'task'
                ? '/activities'
                : `/${kind === 'opportunity' ? 'opportunities' : `${kind}s`}`,
            );
          },
        }))}
      />

      <IconButton label={t('topBar.assistant')} variant="ai" onClick={openAssistant}>
        <Sparkles aria-hidden="true" />
      </IconButton>

      <Popover
        label={t('notifications.title')}
        align="end"
        trigger={
          <IconButton label={t('topBar.notifications')} variant="ghost">
            <Bell aria-hidden="true" />
          </IconButton>
        }
      >
        <p className="text-body-sm font-semibold text-fg">{t('notifications.title')}</p>
        <p className="mt-1 text-body-sm text-fg-secondary">{t('notifications.empty')}</p>
      </Popover>

      <DropdownMenu
        modal={false}
        label={t('topBar.account')}
        trigger={
          <button type="button" aria-label={t('topBar.account')} className="rounded-full">
            <Avatar name={user?.name ?? workspace} size={24} />
          </button>
        }
        items={[
          ...(user
            ? [{ type: 'label' as const, label: t('account.signedInAs', { email: user.email }) }]
            : []),
          {
            type: 'radio',
            label: t('display.theme'),
            value: display.theme,
            options: THEMES.map((theme) => ({
              value: theme,
              label: t(`display.${THEME_LABEL[theme]}`),
            })),
            onValueChange: (theme) => {
              change({ theme: theme as Theme });
            },
          },
          {
            type: 'radio',
            label: t('display.density'),
            value: display.density,
            options: DENSITIES.map((density) => ({
              value: density,
              label: t(`display.${DENSITY_LABEL[density]}`),
            })),
            onValueChange: (density) => {
              change({ density: density as Density });
            },
          },
          { type: 'separator' },
          {
            type: 'item',
            label: t('account.settings'),
            onSelect: () => {
              router.push('/settings/profile');
            },
          },
          { type: 'item', label: t('account.shortcuts'), shortcut: '?', onSelect: openShortcuts },
          { type: 'item', label: tc('actions.signOut'), onSelect: signOut },
        ]}
      />
    </header>
  );
}
