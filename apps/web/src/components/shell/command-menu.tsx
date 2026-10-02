'use client';

import type { RecentItemDto } from '@sm/contracts';
import { CommandPalette, type CommandSection } from '@sm/ui';
import {
  Clock,
  FileText,
  Keyboard,
  LogOut,
  Monitor,
  Moon,
  Rows3,
  Search,
  Sun,
  Trash2,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';

import { cellApi } from '../../lib/cell-api';
import { applyDisplay } from '../../lib/display';
import { OBJECT_ICONS, sectionForObject, type DescribedObject } from '../records/fields';
import {
  describesFor,
  hitDescription,
  readableObjects,
  searchRecords,
  SEARCH_DEBOUNCE_MS,
  type ObjectSummary,
  type SearchResult,
} from '../records/search-client';
import { useShell } from './app-shell';
import { ALL_NAV, visibleNav } from './nav';

type Recent = z.infer<typeof RecentItemDto>;

/** Records per object while typing (§7.19: top 5 per object). */
const PER_OBJECT = 5;

/**
 * ⌘K (§7.19): records (top 5 per object, typo-tolerant, Tab scopes by object), recent items when
 * the query is empty, navigation and display commands. The "Ask AI" section joins in P07.
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
  const { openShortcuts, signOut, user } = useShell();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult | null>(null);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [objects, setObjects] = useState<ObjectSummary[]>([]);
  const [describes, setDescribes] = useState<Map<string, DescribedObject>>(new Map());
  const latest = useRef('');

  useEffect(() => {
    if (!open) return;
    void readableObjects().then(setObjects);
    void cellApi<{ items: Recent[] }>('GET', `/v1/recent-items?limit=${String(PER_OBJECT)}`).then(
      (r) => {
        if (r.ok) setRecent(r.data.items);
      },
    );
  }, [open]);

  useEffect(() => {
    const q = query.trim();
    latest.current = q;
    if (!q) {
      setResults(null);
      return;
    }
    const timer = setTimeout(() => {
      void searchRecords({ q, limit: PER_OBJECT }).then((r) => {
        // An answer to a query the user has moved past is dropped.
        if (latest.current !== q) return;
        void describesFor(r).then((d) => {
          if (latest.current !== q) return;
          setDescribes(d);
          setResults(r);
        });
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [query]);

  const labelOf = (object: string) => objects.find((o) => o.name === object)?.labelPlural ?? object;
  const open_ = (object: string, id: string) => {
    const section = sectionForObject(object);
    if (section) router.push(`/${section}/${id}`);
  };
  const iconOf = (object: string) => {
    const Icon = OBJECT_ICONS[object] ?? FileText;
    return <Icon aria-hidden="true" />;
  };

  const recordSections: CommandSection[] = query.trim()
    ? [
        ...(results?.groups ?? [])
          .filter((g) => g.hits.length > 0 && sectionForObject(g.object))
          .map((g) => ({
            id: `records-${g.object}`,
            heading: labelOf(g.object),
            scope: g.object,
            filtered: true,
            items: g.hits.map((h) => ({
              id: `${g.object}-${h.id}`,
              label: h.name ?? h.id,
              description: hitDescription(h, describes.get(g.object)),
              icon: iconOf(g.object),
              onSelect: () => {
                open_(g.object, h.id);
              },
            })),
          })),
      ]
    : recent.length
      ? [
          {
            id: 'recent',
            heading: t('palette.recent'),
            items: recent
              .filter((r) => sectionForObject(r.object))
              .map((r) => ({
                id: `recent-${r.id}`,
                label: r.name ?? r.id,
                description: labelOf(r.object),
                icon: <Clock aria-hidden="true" />,
                onSelect: () => {
                  open_(r.object, r.id);
                },
              })),
          },
        ]
      : [];

  // "See all results" comes last, so Enter on a plain navigation word still navigates.
  const allResults: CommandSection[] = query.trim()
    ? [
        {
          id: 'all-results',
          heading: t('palette.records'),
          filtered: true,
          items: [
            {
              id: 'see-all',
              label: t('palette.allResults', { query: query.trim() }),
              icon: <Search aria-hidden="true" />,
              onSelect: () => {
                router.push(`/search?q=${encodeURIComponent(query.trim())}`);
              },
            },
          ],
        },
      ]
    : [];

  const sections: CommandSection[] = [
    ...recordSections,
    {
      id: 'go',
      heading: t('palette.navigation'),
      items: visibleNav(ALL_NAV, user?.permissions).map((n) => {
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
          id: 'recycle-bin',
          label: t('palette.recycleBin'),
          icon: <Trash2 aria-hidden="true" />,
          onSelect: () => {
            router.push('/recycle-bin');
          },
        },
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
    ...allResults,
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
      scopes={(results?.groups ?? [])
        .filter((g) => g.hits.length > 0 && sectionForObject(g.object))
        .map((g) => ({ id: g.object, label: labelOf(g.object) }))}
      onQueryChange={setQuery}
    />
  );
}
