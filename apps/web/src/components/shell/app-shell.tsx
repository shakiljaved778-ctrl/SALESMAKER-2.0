'use client';

import { ToastProvider, useToast } from '@sm/ui';
import { usePathname, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { applyDisplay, writePreferenceCookie } from '../../lib/display';
import { PREFERENCE_COOKIES } from '../../lib/preferences';
import { signOut, useSession, type Me } from '../../lib/session';
import { ShellCommandMenu } from './command-menu';
import { ALL_NAV } from './nav';
import { ShortcutSheet } from './shortcut-sheet';
import { Sidebar } from './sidebar';
import { TopBar } from './top-bar';

interface ShellContextValue {
  user: Me | null;
  workspace: string;
  collapsed: boolean;
  toggleSidebar: () => void;
  openPalette: () => void;
  openShortcuts: () => void;
  openAssistant: () => void;
  signOut: () => void;
}

const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell(): ShellContextValue {
  const value = useContext(ShellContext);
  if (!value) throw new Error('useShell must be used inside <AppShell>');
  return value;
}

/** True when a keystroke belongs to a text field rather than to a global shortcut. */
function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
    target.closest('[role="dialog"], [role="menu"], [role="listbox"]') !== null
  );
}

/**
 * App shell (§9.7): dark sidebar (232/56), 48 px top bar, workspace tab bar, content on canvas.
 * Gates on the session (restored from the refresh cookie), applies the user's saved display
 * preferences, and owns the global shortcuts (§9.11).
 */
export function AppShell({
  workspace,
  initialCollapsed,
  children,
}: {
  workspace: string;
  initialCollapsed: boolean;
  children: ReactNode;
}) {
  const t = useTranslations('shell');
  const tc = useTranslations('common');
  return (
    <ToastProvider closeLabel={tc('actions.close')} viewportLabel={t('notifications.title')}>
      <ShellFrame workspace={workspace} initialCollapsed={initialCollapsed}>
        {children}
      </ShellFrame>
    </ToastProvider>
  );
}

function ShellFrame({
  workspace,
  initialCollapsed,
  children,
}: {
  workspace: string;
  initialCollapsed: boolean;
  children: ReactNode;
}) {
  const t = useTranslations('shell');
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const session = useSession();
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const pendingGo = useRef<number | null>(null);
  const user = session.status === 'signed-in' ? session.session.user : null;

  useEffect(() => {
    if (session.status === 'signed-out') router.replace('/sign-in');
  }, [session.status, router]);

  // The profile is the source of truth for display preferences (§9.6); the cookie is its cache.
  useEffect(() => {
    if (!user) return;
    const root = document.documentElement;
    const change: { theme?: Me['theme']; density?: Me['density'] } = {};
    if (root.dataset.theme !== user.theme) change.theme = user.theme;
    if (root.dataset.density !== user.density) change.density = user.density;
    if (change.theme || change.density) applyDisplay(change, false);
  }, [user]);

  const toggleSidebar = useCallback(() => {
    setCollapsed((c) => {
      writePreferenceCookie(PREFERENCE_COOKIES.sidebar, c ? 'expanded' : 'collapsed');
      return !c;
    });
  }, []);
  const openAssistant = useCallback(() => {
    toast({ tone: 'info', title: t('topBar.assistant'), description: t('comingSoon') });
  }, [toast, t]);
  const doSignOut = useCallback(() => {
    void signOut().then(() => {
      router.replace('/sign-in');
    });
  }, [router]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (mod && event.key.toLowerCase() === 'j') {
        event.preventDefault();
        openAssistant();
        return;
      }
      if (mod || event.altKey || typingIn(event.target)) return;
      if (pendingGo.current !== null) {
        window.clearTimeout(pendingGo.current);
        pendingGo.current = null;
        const target = ALL_NAV.find((n) => n.go === event.key.toLowerCase());
        if (target) {
          event.preventDefault();
          router.push(target.href);
        }
        return;
      }
      if (event.key === '[') {
        event.preventDefault();
        toggleSidebar();
      } else if (event.key === '?') {
        event.preventDefault();
        setShortcutsOpen(true);
      } else if (event.key.toLowerCase() === 'g') {
        pendingGo.current = window.setTimeout(() => {
          pendingGo.current = null;
        }, 1500);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [router, toggleSidebar, openAssistant]);

  const value: ShellContextValue = {
    user,
    workspace,
    collapsed,
    toggleSidebar,
    openPalette: () => {
      setPaletteOpen(true);
    },
    openShortcuts: () => {
      setShortcutsOpen(true);
    },
    openAssistant,
    signOut: doSignOut,
  };

  return (
    <ShellContext.Provider value={value}>
      <a
        href="#content"
        className="sr-only z-[var(--z-tooltip)] rounded-sm bg-surface-raised px-3 py-2 text-body text-fg focus:not-sr-only focus:fixed focus:start-2 focus:top-2"
      >
        {t('skipToContent')}
      </a>
      <div className="flex h-dvh overflow-hidden bg-canvas">
        <Sidebar pathname={pathname} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar pathname={pathname} />
          <div
            role="region"
            aria-label={t('tabs.label')}
            className="flex h-9 shrink-0 items-center border-b border-line-subtle bg-surface px-4 text-caption text-fg-secondary"
          >
            {t('tabs.empty')}
          </div>
          <main id="content" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
            {children}
          </main>
        </div>
      </div>
      <ShellCommandMenu open={paletteOpen} onOpenChange={setPaletteOpen} />
      <ShortcutSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </ShellContext.Provider>
  );
}
