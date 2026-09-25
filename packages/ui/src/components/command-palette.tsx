import { Command } from 'cmdk';
import { Search } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';

import { fuzzyMatch } from '../lib/fuzzy.js';
import { Kbd } from './primitives.js';

export interface CommandItem {
  id: string;
  label: string;
  /** Secondary text, e.g. a record's account or a command's context. */
  description?: string;
  icon?: ReactNode;
  /** Shortcut keys shown at the end, e.g. ['G', 'L']. */
  shortcut?: string[];
  /** Extra terms that match without being shown (synonyms, object names). */
  keywords?: string[];
  onSelect: () => void;
}

export interface CommandSection {
  id: string;
  heading: string;
  /** Scope this section belongs to (e.g. an object), for Tab scoping. */
  scope?: string;
  items: CommandItem[];
}

export interface CommandScope {
  id: string;
  label: string;
}

export interface CommandPaletteHints {
  navigate: string;
  select: string;
  scope: string;
  close: string;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name of the palette dialog. */
  label: string;
  placeholder: string;
  emptyText: string;
  sections: CommandSection[];
  /** Tab cycles through these scopes (e.g. objects); Shift+Tab goes back (§9.10). */
  scopes?: CommandScope[];
  hints: CommandPaletteHints;
  /** Most matches shown per section while typing (§7.19: top 5 per object). */
  limitPerSection?: number;
  initialQuery?: string;
  /** Controlled query, for callers that search remotely as the user types. */
  onQueryChange?: (query: string) => void;
}

interface Ranked {
  item: CommandItem;
  score: number;
  positions: number[];
}

function rank(items: CommandItem[], query: string, limit: number): Ranked[] {
  if (!query.trim()) return items.map((item) => ({ item, score: 0, positions: [] }));
  const ranked: Ranked[] = [];
  for (const item of items) {
    const onLabel = fuzzyMatch(query, item.label);
    if (onLabel) {
      ranked.push({ item, score: onLabel.score, positions: onLabel.positions });
      continue;
    }
    // Matches on hidden terms rank below visible ones and highlight nothing.
    const hidden = [item.description ?? '', ...(item.keywords ?? [])]
      .map((term) => fuzzyMatch(query, term))
      .filter((m) => m !== null);
    if (hidden.length) {
      ranked.push({ item, score: Math.max(...hidden.map((m) => m.score)) / 2, positions: [] });
    }
  }
  return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Wrap matched characters in <mark> so the match is visible, not only coloured. */
export function Highlight({ text, positions }: { text: string; positions: number[] }) {
  if (!positions.length) return <>{text}</>;
  const hit = new Set(positions);
  const parts: ReactNode[] = [];
  let run = '';
  let runHit = false;
  const flush = (key: number) => {
    if (!run) return;
    parts.push(
      runHit ? (
        <mark key={key} className="bg-transparent font-semibold text-fg">
          {run}
        </mark>
      ) : (
        run
      ),
    );
    run = '';
  };
  for (let i = 0; i < text.length; i++) {
    const isHit = hit.has(i);
    if (isHit !== runHit) {
      flush(i);
      runHit = isHit;
    }
    run += text.charAt(i);
  }
  flush(text.length);
  return <>{parts}</>;
}

/**
 * Global command palette (§7.19, §9.10): 640 px, r-lg, e-3; sections (records, commands,
 * recent, and Ask AI from P07); fuzzy matching with highlighting; ↑↓ Enter; Tab to scope.
 * The caller owns ⌘K and supplies every string (golden rule 5).
 */
export function CommandPalette({
  open,
  onOpenChange,
  label,
  placeholder,
  emptyText,
  sections,
  scopes = [],
  hints,
  limitPerSection = 5,
  initialQuery = '',
  onQueryChange,
}: CommandPaletteProps) {
  const [query, setQuery] = useState(initialQuery);
  const [scopeIndex, setScopeIndex] = useState(-1);
  const scope = scopes[scopeIndex];

  const visible = useMemo(
    () =>
      sections
        .filter((s) => !scope || s.scope === scope.id)
        .map((s) => ({ section: s, ranked: rank(s.items, query, limitPerSection) }))
        .filter((s) => s.ranked.length > 0),
    [sections, scope, query, limitPerSection],
  );

  const changeQuery = (next: string) => {
    setQuery(next);
    onQueryChange?.(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Tab' && scopes.length > 0) {
      event.preventDefault();
      // -1 is "everything"; Tab walks forward through the scopes and wraps back to it.
      const count = scopes.length + 1;
      setScopeIndex((i) => ((i + 1 + (event.shiftKey ? -1 : 1) + count) % count) - 1);
    } else if (event.key === 'Backspace' && !query && scope) {
      setScopeIndex(-1);
    }
  };

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setQuery('');
      setScopeIndex(-1);
    }
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={close}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[var(--z-palette)] bg-overlay animate-fade-in" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed start-1/2 top-[12dvh] z-[var(--z-palette)] flex max-h-[70dvh] w-[calc(100vw-2rem)] max-w-160 -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-line bg-surface-raised shadow-e3 animate-pop-in rtl:translate-x-1/2"
        >
          <DialogPrimitive.Title className="sr-only">{label}</DialogPrimitive.Title>
          <Command shouldFilter={false} loop label={label} className="flex min-h-0 flex-col">
            <div className="flex items-center gap-2 border-b border-line-subtle px-4 [&_svg]:size-4">
              <Search aria-hidden="true" className="shrink-0 text-fg-secondary" />
              {scope ? (
                <span className="shrink-0 rounded-xs bg-selected px-1.5 py-0.5 text-micro text-fg">
                  {scope.label}
                </span>
              ) : null}
              <Command.Input
                value={query}
                onValueChange={changeQuery}
                onKeyDown={onKeyDown}
                placeholder={placeholder}
                className="h-12 min-w-0 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-fg-secondary"
              />
            </div>
            <Command.List className="min-h-0 flex-1 overflow-y-auto p-2">
              <Command.Empty className="px-2 py-6 text-center text-body-sm text-fg-secondary">
                {emptyText}
              </Command.Empty>
              {visible.map(({ section, ranked }) => (
                <Command.Group
                  key={section.id}
                  heading={section.heading}
                  className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-micro [&_[cmdk-group-heading]]:text-fg-secondary"
                >
                  {ranked.map(({ item, positions }) => (
                    <Command.Item
                      key={item.id}
                      value={`${section.id}:${item.id}`}
                      onSelect={() => {
                        close(false);
                        item.onSelect();
                      }}
                      className="flex cursor-default items-center gap-2.5 rounded-sm px-2 py-2 text-body text-fg data-[selected=true]:bg-hover [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-secondary"
                    >
                      {item.icon}
                      <span className="min-w-0 flex-1 truncate">
                        <Highlight text={item.label} positions={positions} />
                        {item.description ? (
                          <span className="ms-2 text-body-sm text-fg-secondary">
                            {item.description}
                          </span>
                        ) : null}
                      </span>
                      {item.shortcut ? (
                        <span className="flex shrink-0 gap-1">
                          {item.shortcut.map((key) => (
                            <Kbd key={key}>{key}</Kbd>
                          ))}
                        </span>
                      ) : null}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
            </Command.List>
            <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line-subtle px-4 py-2 text-caption text-fg-secondary">
              <span className="flex items-center gap-1">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
                {hints.navigate}
              </span>
              <span className="flex items-center gap-1">
                <Kbd>↵</Kbd>
                {hints.select}
              </span>
              {scopes.length > 0 ? (
                <span className="flex items-center gap-1">
                  <Kbd>Tab</Kbd>
                  {hints.scope}
                </span>
              ) : null}
              <span className="flex items-center gap-1">
                <Kbd>Esc</Kbd>
                {hints.close}
              </span>
            </footer>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
