'use client';

import { Command } from 'cmdk';
import { Check, ChevronsUpDown, LoaderCircle, Plus } from 'lucide-react';
import { Popover } from 'radix-ui';
import { useState, type ReactNode } from 'react';

import { cn } from '../lib/cn.js';
import { useFormField } from './form-field.js';

export interface ComboboxOption {
  value: string;
  label: string;
  /** Secondary text, e.g. a lookup's company or email (§9.10). */
  description?: string;
  icon?: ReactNode;
}

export interface ComboboxProps {
  options: ComboboxOption[];
  value?: string | undefined;
  onValueChange?: (value: string) => void;
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  /** Async search for lookups: called (debounced 150 ms) as the user types; show `loading` meanwhile. */
  onSearch?: (query: string) => void;
  loading?: boolean;
  loadingText?: string;
  /** "Create new…" row, when the user may create the record inline. */
  onCreate?: (query: string) => void;
  createLabel?: (query: string) => string;
  disabled?: boolean;
  'aria-label'?: string;
  className?: string;
}

/**
 * Searchable single-select (§9.10): used past 7 options and for lookups. Filters locally, or
 * hands the query to `onSearch` for async lookups; optional "Create new…".
 */
export function Combobox({
  options,
  value,
  onValueChange,
  placeholder,
  searchPlaceholder,
  emptyText,
  onSearch,
  loading = false,
  loadingText,
  onCreate,
  createLabel,
  disabled,
  className,
  ...aria
}: ComboboxProps) {
  const field = useFormField();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [timer, setTimer] = useState<ReturnType<typeof setTimeout> | undefined>();
  const selected = options.find((o) => o.value === value);

  const search = (q: string) => {
    setQuery(q);
    if (!onSearch) return;
    if (timer) clearTimeout(timer);
    setTimer(
      setTimeout(() => {
        onSearch(q);
      }, 150),
    );
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild disabled={disabled ?? field?.disabled}>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={aria['aria-label']}
          id={field?.id}
          aria-describedby={field?.describedBy}
          aria-invalid={field?.invalid || undefined}
          className={cn(
            'flex h-[var(--control-height)] w-full items-center justify-between gap-2 rounded-sm border border-line bg-surface px-2.5 text-start text-body hover:border-line-strong aria-invalid:border-danger disabled:cursor-not-allowed disabled:bg-muted disabled:text-fg-disabled [&_svg]:size-4',
            selected ? 'text-fg' : 'text-fg-secondary',
            className,
          )}
        >
          <span className="flex min-w-0 items-center gap-2 truncate">
            {selected?.icon}
            {selected?.label ?? placeholder}
          </span>
          <ChevronsUpDown aria-hidden="true" className="shrink-0 text-fg-secondary" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={4}
          align="start"
          className="z-[var(--z-popover)] w-[var(--radix-popover-trigger-width)] min-w-56 rounded-md border border-line bg-surface-raised p-1 shadow-e2"
        >
          <Command shouldFilter={!onSearch} className="flex flex-col">
            <Command.Input
              value={query}
              onValueChange={search}
              placeholder={searchPlaceholder}
              className="mb-1 h-8 w-full rounded-sm border border-line bg-surface px-2 text-body text-fg outline-none placeholder:text-fg-secondary focus-visible:border-focus"
            />
            <Command.List className="max-h-64 overflow-y-auto">
              {loading ? (
                <Command.Loading>
                  <div className="flex items-center gap-2 px-2 py-1.5 text-body-sm text-fg-secondary [&_svg]:size-4">
                    <LoaderCircle className="animate-spin" aria-hidden="true" />
                    {loadingText}
                  </div>
                </Command.Loading>
              ) : null}
              <Command.Empty className="px-2 py-1.5 text-body-sm text-fg-secondary">
                {emptyText}
              </Command.Empty>
              {options.map((o) => (
                <Command.Item
                  key={o.value}
                  value={`${o.label} ${o.description ?? ''} ${o.value}`}
                  onSelect={() => {
                    onValueChange?.(o.value);
                    setOpen(false);
                  }}
                  className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-body text-fg data-[selected=true]:bg-hover [&_svg]:size-4"
                >
                  {o.icon}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{o.label}</span>
                    {o.description ? (
                      <span className="truncate text-caption text-fg-secondary">
                        {o.description}
                      </span>
                    ) : null}
                  </span>
                  {o.value === value ? <Check aria-hidden="true" className="text-primary" /> : null}
                </Command.Item>
              ))}
              {onCreate && query.trim() ? (
                <Command.Item
                  value={`__create__${query}`}
                  onSelect={() => {
                    onCreate(query.trim());
                    setOpen(false);
                  }}
                  className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-body text-link data-[selected=true]:bg-hover [&_svg]:size-4"
                >
                  <Plus aria-hidden="true" />
                  {createLabel ? createLabel(query.trim()) : query.trim()}
                </Command.Item>
              ) : null}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
