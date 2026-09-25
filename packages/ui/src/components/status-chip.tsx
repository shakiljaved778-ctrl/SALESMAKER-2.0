import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';

import { cn } from '../lib/cn.js';

export const statusChipVariants = cva(
  'inline-flex h-5 max-w-full items-center gap-1 rounded-xs px-1.5 text-micro whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'bg-neutral-bg text-neutral',
        success: 'bg-success-bg text-success',
        warning: 'bg-warning-bg text-warning',
        danger: 'bg-danger-bg text-danger',
        info: 'bg-info-bg text-info',
        ai: 'border border-ai-border bg-ai-bg text-ai',
        // Categorical tones for stages and tags. Stage chips never use slot 3 (Iris) (§9.2).
        'cat-1': 'bg-cat-1-bg text-cat-1-fg',
        'cat-2': 'bg-cat-2-bg text-cat-2-fg',
        'cat-4': 'bg-cat-4-bg text-cat-4-fg',
        'cat-5': 'bg-cat-5-bg text-cat-5-fg',
        'cat-6': 'bg-cat-6-bg text-cat-6-fg',
        'cat-7': 'bg-cat-7-bg text-cat-7-fg',
        'cat-8': 'bg-cat-8-bg text-cat-8-fg',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface StatusChipProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof statusChipVariants> {
  /** Leading dot in the chip's colour. The text always carries the meaning (§9.13). */
  dot?: boolean;
}

/** Picklist badge / status chip (§9.10): r-xs, micro text, colour from status or categorical tokens. */
export function StatusChip({ tone, dot = false, className, children, ...props }: StatusChipProps) {
  return (
    <span className={cn(statusChipVariants({ tone }), className)} {...props}>
      {dot ? (
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />
      ) : null}
      <span className="truncate">{children}</span>
    </span>
  );
}
