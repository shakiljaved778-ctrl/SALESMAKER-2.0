import { Tabs as TabsPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn.js';

export interface TabItem {
  value: string;
  label: string;
  count?: number;
  content: ReactNode;
}

/** Tabs (§9.10): underline style with a 2px primary indicator; counts as micro badges. */
export function Tabs({
  items,
  defaultValue,
  value,
  onValueChange,
  label,
  className,
}: {
  items: TabItem[];
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  label: string;
  className?: string;
}) {
  return (
    <TabsPrimitive.Root
      defaultValue={defaultValue ?? items[0]?.value}
      {...(value === undefined ? {} : { value })}
      {...(onValueChange ? { onValueChange } : {})}
      className={cn('flex flex-col', className)}
    >
      <TabsPrimitive.List aria-label={label} className="flex gap-4 border-b border-line">
        {items.map((t) => (
          <TabsPrimitive.Trigger
            key={t.value}
            value={t.value}
            className="relative -mb-px flex h-9 items-center gap-1.5 border-b-2 border-transparent text-body text-fg-secondary hover:text-fg data-[state=active]:border-primary data-[state=active]:font-medium data-[state=active]:text-fg"
          >
            {t.label}
            {t.count === undefined ? null : (
              <span className="tabular rounded-xs bg-muted px-1 text-micro text-fg-secondary">
                {t.count}
              </span>
            )}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {items.map((t) => (
        <TabsPrimitive.Content key={t.value} value={t.value} className="pt-4">
          {t.content}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  );
}
