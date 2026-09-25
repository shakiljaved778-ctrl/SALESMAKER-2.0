'use client';

import { DropdownMenu as MenuPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn.js';
import { Kbd } from './primitives.js';

export type MenuEntry =
  | {
      type: 'item';
      label: string;
      icon?: ReactNode;
      shortcut?: string;
      destructive?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | { type: 'separator' }
  | { type: 'label'; label: string };

/** Dropdown menu (§9.10): keyboard navigable, icons, shortcut hints, destructive items last. */
export function DropdownMenu({
  trigger,
  items,
  align = 'end',
  label,
  defaultOpen,
  modal = true,
}: {
  trigger: ReactNode;
  items: MenuEntry[];
  align?: 'start' | 'end';
  label?: string;
  defaultOpen?: boolean;
  /** Modal menus trap focus and hide the rest of the page from assistive tech (default). */
  modal?: boolean;
}) {
  return (
    <MenuPrimitive.Root modal={modal} {...(defaultOpen ? { defaultOpen } : {})}>
      <MenuPrimitive.Trigger asChild>{trigger}</MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Content
          align={align}
          sideOffset={4}
          aria-label={label}
          className="z-[var(--z-popover)] min-w-48 rounded-md border border-line bg-surface-raised p-1 text-fg shadow-e2 animate-pop-in"
        >
          {items.map((entry, i) => {
            if (entry.type === 'separator')
              return (
                <MenuPrimitive.Separator
                  key={`sep-${String(i)}`}
                  className="my-1 h-px bg-line-subtle"
                />
              );
            if (entry.type === 'label') {
              return (
                <MenuPrimitive.Label
                  key={`label-${entry.label}`}
                  className="px-2 pb-1 pt-1.5 text-label text-fg-secondary"
                >
                  {entry.label}
                </MenuPrimitive.Label>
              );
            }
            return (
              <MenuPrimitive.Item
                key={entry.label}
                disabled={entry.disabled}
                onSelect={entry.onSelect}
                className={cn(
                  'flex h-8 cursor-default select-none items-center gap-2 rounded-sm px-2 text-body outline-none data-[disabled]:text-fg-disabled data-[highlighted]:bg-hover [&_svg]:size-4',
                  entry.destructive && 'text-danger',
                )}
              >
                {entry.icon}
                <span className="flex-1 truncate">{entry.label}</span>
                {entry.shortcut ? <Kbd>{entry.shortcut}</Kbd> : null}
              </MenuPrimitive.Item>
            );
          })}
        </MenuPrimitive.Content>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}
