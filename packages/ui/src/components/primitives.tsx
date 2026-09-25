import { Separator as SeparatorPrimitive } from 'radix-ui';
import type { ComponentPropsWithoutRef, HTMLAttributes, ReactNode } from 'react';

import { cn } from '../lib/cn.js';

/** Keyboard key hint (§9.11), e.g. <Kbd>⌘</Kbd><Kbd>K</Kbd>. */
export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-line bg-subtle px-1 font-mono text-micro text-fg-secondary',
        className,
      )}
      {...props}
    />
  );
}

export function Separator({
  className,
  orientation = 'horizontal',
  ...props
}: ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      orientation={orientation}
      className={cn(
        'shrink-0 bg-line-subtle',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    />
  );
}

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}

/** Card (§9.4): surface, 1px border, r-md, e-1, padding by density. */
export function Card({ title, subtitle, actions, className, children, ...props }: CardProps) {
  return (
    <section
      className={cn(
        'rounded-md border border-line bg-surface p-[var(--card-padding)] shadow-e1',
        className,
      )}
      {...props}
    >
      {title || actions ? (
        <header className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title ? <h3 className="truncate text-title-3 text-fg">{title}</h3> : null}
            {subtitle ? <p className="text-caption text-fg-secondary">{subtitle}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}
