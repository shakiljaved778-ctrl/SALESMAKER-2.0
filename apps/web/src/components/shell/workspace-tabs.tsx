'use client';

import { cn } from '@sm/ui';
import { X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export interface WorkspaceTab {
  href: string;
  title: string;
}

/** Older tabs drop off past this many (§9.7 workspace tab bar). */
export const MAX_TABS = 10;
const STORAGE_KEY = 'sm_workspace_tabs';

interface TabsContextValue {
  tabs: WorkspaceTab[];
  open: (tab: WorkspaceTab) => void;
  close: (href: string) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function restore(): WorkspaceTab[] {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed
          .filter(
            (t): t is WorkspaceTab =>
              typeof t === 'object' &&
              t !== null &&
              typeof (t as WorkspaceTab).href === 'string' &&
              (t as WorkspaceTab).href.startsWith('/') &&
              typeof (t as WorkspaceTab).title === 'string',
          )
          .slice(0, MAX_TABS)
      : [];
  } catch {
    return [];
  }
}

/** Open records as tabs for this browser tab's session (a per-viewer convenience). */
export function WorkspaceTabsProvider({ children }: { children: ReactNode }) {
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  useEffect(() => {
    setTabs(restore());
  }, []);
  const save = (next: WorkspaceTab[]) => {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage may be unavailable (private mode); tabs then last for the page only.
    }
    return next;
  };
  const open = useCallback((tab: WorkspaceTab) => {
    setTabs((prev) => {
      const at = prev.findIndex((t) => t.href === tab.href);
      if (at >= 0) {
        if (prev[at]?.title === tab.title) return prev;
        return save(prev.map((t, i) => (i === at ? tab : t)));
      }
      return save([...prev, tab].slice(-MAX_TABS));
    });
  }, []);
  const close = useCallback((href: string) => {
    setTabs((prev) => save(prev.filter((t) => t.href !== href)));
  }, []);
  const value = useMemo(() => ({ tabs, open, close }), [tabs, open, close]);
  return <TabsContext.Provider value={value}>{children}</TabsContext.Provider>;
}

/** Register the current record as a workspace tab (once its title is known). */
export function useWorkspaceTab(tab: WorkspaceTab | null): void {
  const ctx = useContext(TabsContext);
  const open = ctx?.open;
  const href = tab?.href;
  const title = tab?.title;
  useEffect(() => {
    if (open && href && title) open({ href, title });
  }, [open, href, title]);
}

/** The tab bar under the top bar: open records, the current one marked, each closable. */
export function WorkspaceTabStrip() {
  const t = useTranslations('shell.tabs');
  const ctx = useContext(TabsContext);
  const pathname = usePathname();
  const router = useRouter();
  const tabs = ctx?.tabs ?? [];
  return (
    <nav
      aria-label={t('label')}
      className="flex h-9 shrink-0 items-stretch gap-1 overflow-x-auto border-b border-line-subtle bg-surface px-2 text-caption text-fg-secondary"
    >
      {tabs.length === 0 ? (
        <span className="flex items-center px-2">{t('empty')}</span>
      ) : (
        tabs.map((tab) => {
          const current = pathname === tab.href;
          return (
            <span
              key={tab.href}
              className={cn(
                'group flex max-w-56 items-center gap-1 border-b-2 ps-2 pe-1',
                current ? 'border-primary text-fg' : 'border-transparent hover:text-fg',
              )}
            >
              <Link
                href={tab.href}
                prefetch={false}
                aria-current={current ? 'page' : undefined}
                className="truncate py-1.5 text-body-sm"
              >
                {tab.title}
              </Link>
              <button
                type="button"
                aria-label={`${t('close')}: ${tab.title}`}
                className="grid size-5 place-items-center rounded-xs text-fg-tertiary hover:bg-hover hover:text-fg"
                onClick={() => {
                  ctx?.close(tab.href);
                  if (current) {
                    const rest = tabs.filter((x) => x.href !== tab.href);
                    router.push(rest.at(-1)?.href ?? '/home');
                  }
                }}
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </span>
          );
        })
      )}
    </nav>
  );
}
