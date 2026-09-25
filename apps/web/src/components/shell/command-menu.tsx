'use client';

import { CommandPalette, type CommandSection } from '@sm/ui';
import { Keyboard, LogOut, Monitor, Moon, Rows3, Sun } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { applyDisplay } from '../../lib/display';
import { useShell } from './app-shell';
import { ALL_NAV } from './nav';

/**
 * ⌘K in P00 (§7.19): navigation and display commands. Record search joins in P02, and the
 * "Ask AI" section in P07.
 */
export function ShellCommandMenu({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('shell');
  const tc = useTranslations('common');
  const router = useRouter();
  const { openShortcuts, signOut } = useShell();

  const sections: CommandSection[] = [
    {
      id: 'go',
      heading: t('palette.navigation'),
      items: ALL_NAV.map((n) => {
        const Icon = n.icon;
        return {
          id: n.key,
          label: t(`nav.${n.key}`),
          icon: <Icon aria-hidden="true" />,
          ...(n.go ? { shortcut: ['G', n.go.toUpperCase()] } : {}),
          onSelect: () => {
            router.push(n.href);
          },
        };
      }),
    },
    {
      id: 'commands',
      heading: t('palette.commands'),
      items: [
        ...(
          [
            ['light', 'themeLight', Sun],
            ['dark', 'themeDark', Moon],
            ['system', 'themeSystem', Monitor],
          ] as const
        ).map(([theme, key, Icon]) => ({
          id: `theme-${theme}`,
          label: t('palette.switchTheme', { theme: t(`display.${key}`) }),
          icon: <Icon aria-hidden="true" />,
          onSelect: () => {
            applyDisplay({ theme });
          },
        })),
        ...(
          [
            ['comfortable', 'densityComfortable'],
            ['default', 'densityDefault'],
            ['compact', 'densityCompact'],
          ] as const
        ).map(([density, key]) => ({
          id: `density-${density}`,
          label: t('palette.setDensity', { density: t(`display.${key}`) }),
          icon: <Rows3 aria-hidden="true" />,
          onSelect: () => {
            applyDisplay({ density });
          },
        })),
        {
          id: 'shortcuts',
          label: t('palette.showShortcuts'),
          icon: <Keyboard aria-hidden="true" />,
          shortcut: ['?'],
          onSelect: openShortcuts,
        },
        {
          id: 'sign-out',
          label: tc('actions.signOut'),
          icon: <LogOut aria-hidden="true" data-mirror="" />,
          onSelect: signOut,
        },
      ],
    },
  ];

  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      label={t('palette.label')}
      placeholder={t('palette.placeholder')}
      emptyText={t('palette.noResults')}
      sections={sections}
      hints={{
        navigate: t('palette.hints.navigate'),
        select: t('palette.hints.select'),
        scope: t('palette.hints.scope'),
        close: t('palette.hints.close'),
      }}
      limitPerSection={8}
    />
  );
}
