'use client';

import { cva, type VariantProps } from 'class-variance-authority';
import { LoaderCircle, Sparkles } from 'lucide-react';
import { Slot } from 'radix-ui';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

import { cn } from '../lib/cn.js';
import { Tooltip } from './tooltip.js';

export const buttonVariants = cva(
  'relative inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-sm font-medium transition-colors duration-100 ease-standard disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-on-primary hover:bg-primary-hover active:bg-primary-active',
        secondary: 'border border-secondary-border bg-secondary text-on-secondary hover:bg-hover',
        ghost: 'text-fg hover:bg-hover',
        danger: 'bg-destructive text-on-destructive hover:opacity-90',
        ai: 'border border-ai-border bg-surface text-ai hover:bg-ai-bg',
        link: 'h-auto px-0 text-link underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-7 px-2.5 text-body-sm',
        md: 'h-[var(--control-height)] px-3 text-body',
        lg: 'h-10 px-4 text-body',
      },
    },
    compoundVariants: [{ variant: 'link', className: 'h-auto px-0' }],
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Shows a spinner, keeps the button's width, and blocks further clicks. */
  loading?: boolean;
  /** Text announced while loading (from i18n), e.g. "Saving…". */
  loadingLabel?: string;
  /** Leading icon; the `ai` variant shows the sparkle automatically. */
  icon?: ReactNode;
  /** Render as the child element (e.g. a Next.js Link) with button styling. */
  asChild?: boolean;
}

/** Button (§9.10): primary, secondary, ghost, danger, ai (Iris), link; sm/md/lg; loading keeps width. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant,
    size,
    loading = false,
    loadingLabel,
    icon,
    asChild = false,
    disabled,
    children,
    type,
    ...props
  },
  ref,
) {
  const leading = variant === 'ai' && !icon ? <Sparkles aria-hidden="true" /> : icon;
  if (asChild) {
    return (
      <Slot.Root ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled ?? loading}
      aria-busy={loading || undefined}
      data-variant={variant ?? 'secondary'}
      {...props}
    >
      <span className={cn('inline-flex items-center gap-1.5', loading && 'invisible')}>
        {leading}
        {children}
      </span>
      {loading ? (
        <span className="absolute inset-0 flex items-center justify-center">
          <LoaderCircle className="animate-spin" aria-hidden="true" />
          {loadingLabel ? <span className="sr-only">{loadingLabel}</span> : null}
        </span>
      ) : null}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'icon' | 'asChild'> {
  /** Accessible name; also shown as the tooltip (§9.10: icon-only buttons need one). */
  label: string;
  children: ReactNode;
}

/** Square, icon-only button. `label` is mandatory: it is the accessible name and the tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, className, size, variant, children, ...props },
  ref,
) {
  const square =
    size === 'sm' ? 'w-7 px-0' : size === 'lg' ? 'w-10 px-0' : 'w-[var(--control-height)] px-0';
  return (
    <Tooltip content={label}>
      <Button
        ref={ref}
        aria-label={label}
        variant={variant ?? 'ghost'}
        size={size}
        className={cn(square, className)}
        {...props}
      >
        {children}
      </Button>
    </Tooltip>
  );
});
