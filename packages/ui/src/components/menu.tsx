'use client';

import { Check } from 'lucide-react';
import { DropdownMenu as MenuPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn.js';
import { usePopoverLayerClass } from '../lib/layer.js';
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
  | { type: 'label'; label: string }
  | {
      /** A set of exclusive choices (e.g. theme); exposed as menuitemradio with aria-checked. */
      type: 'radio';
      label: string;
      value: string;
      options: { value: string; label: string }[];
      onValueChange: (value: string) => void;
    };

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
  const layer = usePopoverLayerClass();
  return (
    <MenuPrimitive.Root modal={modal} {...(defaultOpen ? { defaultOpen } : {})}>
      <MenuPrimitive.Trigger asChild>{trigger}</MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Content
          align={align}
          sideOffset={4}
          aria-label={label}
          className={cn(
            layer,
            'min-w-48 rounded-md border border-line bg-surface-raised p-1 text-fg shadow-e2 animate-pop-in',
          )}
        >
          {items.map((entry, i) => {
            if (entry.type === 'separator')
              return (
                <MenuPrimitive.Separator
                  key={`sep-${String(i)}`}
                  className="my-1 h-px bg-line-subtle"
                />
              );
            if (entry.type === 'radio') {
              return (
                <MenuPrimitive.Group key={`radio-${entry.label}`}>
                  <MenuPrimitive.Label className="px-2 pb-1 pt-1.5 text-label text-fg-secondary">
                    {entry.label}
                  </MenuPrimitive.Label>
                  <MenuPrimitive.RadioGroup value={entry.value} onValueChange={entry.onValueChange}>
                    {entry.options.map((option) => (
                      <MenuPrimitive.RadioItem
                        key={option.value}
                        value={option.value}
                        onSelect={(event) => {
                          event.preventDefault();
                        }}
                        className="flex h-8 cursor-default select-none items-center gap-2 rounded-sm ps-8 pe-2 text-body outline-none data-[highlighted]:bg-hover relative [&_svg]:size-4"
                      >
                        <MenuPrimitive.ItemIndicator className="absolute start-2 inline-flex text-primary">
                          <Check aria-hidden="true" />
                        </MenuPrimitive.ItemIndicator>
                        {option.label}
                      </MenuPrimitive.RadioItem>
                    ))}
                  </MenuPrimitive.RadioGroup>
                </MenuPrimitive.Group>
              );
            }
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
