import { cva } from 'class-variance-authority';
import { CircleAlert, Info, Sparkles, TriangleAlert, X } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '../lib/cn.js';

export type BannerTone = 'info' | 'warning' | 'danger' | 'ai';

const bannerVariants = cva(
  'flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-body-sm text-fg [&_svg]:size-4',
  {
    variants: {
      tone: {
        info: 'border-info/30 bg-info-bg',
        warning: 'border-warning/30 bg-warning-bg',
        danger: 'border-danger/30 bg-danger-bg',
        // Iris is reserved for AI (§9.2).
        ai: 'border-ai-border bg-ai-bg',
      },
    },
  },
);

const BANNER_ICON = { info: Info, warning: TriangleAlert, danger: CircleAlert, ai: Sparkles };
const BANNER_ICON_TONE = {
  info: 'text-info',
  warning: 'text-warning',
  danger: 'text-danger',
  ai: 'text-ai',
};

export interface BannerProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  tone: BannerTone;
  title?: string;
  /** One action, e.g. "Reload" or "Review approval". */
  action?: ReactNode;
  /** Dismissible banners need both. Persistent states (a locked record) omit them. */
  onDismiss?: () => void;
  dismissLabel?: string;
}

/**
 * Inline banner across the top of a page or card (§9.10), e.g. "This record is locked for
 * approval". Danger banners are announced assertively; the others politely.
 */
export function Banner({
  tone,
  title,
  action,
  onDismiss,
  dismissLabel,
  className,
  children,
  ...props
}: BannerProps) {
  const Icon = BANNER_ICON[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      data-tone={tone}
      className={cn(bannerVariants({ tone }), className)}
      {...props}
    >
      <Icon aria-hidden="true" className={cn('mt-0.5 shrink-0', BANNER_ICON_TONE[tone])} />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? (
          <div className={title ? 'text-fg-secondary' : undefined}>{children}</div>
        ) : null}
      </div>
      {action ? <div className="shrink-0 self-center">{action}</div> : null}
      {onDismiss && dismissLabel ? (
        <button
          type="button"
          aria-label={dismissLabel}
          onClick={onDismiss}
          className="shrink-0 rounded-xs text-fg-secondary hover:text-fg"
        >
          <X aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export interface EmptyStateProps {
  /** A 20 px Lucide icon; it sits in a 40 px muted circle. */
  icon: ReactNode;
  title: string;
  /** One sentence that teaches the next step; never "No data" (§9.14). */
  description: string;
  /** One primary action. */
  action?: ReactNode;
  learnMore?: { label: string; href: string };
  className?: string;
}

/** Empty state (§9.10): icon, title-3 headline, one sentence, one primary action, optional link. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  learnMore,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'mx-auto flex max-w-sm flex-col items-center gap-3 px-4 py-10 text-center',
        className,
      )}
    >
      <div
        aria-hidden="true"
        className="flex size-10 items-center justify-center rounded-full bg-muted text-fg-secondary [&_svg]:size-5"
      >
        {icon}
      </div>
      <div className="flex flex-col gap-1">
        <h3 className="text-title-3 text-fg">{title}</h3>
        <p className="text-body-sm text-fg-secondary">{description}</p>
      </div>
      {action || learnMore ? (
        <div className="flex flex-col items-center gap-2">
          {action}
          {learnMore ? (
            <a
              href={learnMore.href}
              className="text-body-sm text-link underline-offset-2 hover:underline"
            >
              {learnMore.label}
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  /** Circles for avatars; rounded blocks otherwise. */
  shape?: 'block' | 'circle' | 'text';
}

/**
 * Loading placeholder (§9.10). Size it to match the final layout; the shimmer stops under reduced
 * motion. Hidden from assistive tech: mark the loading region with `aria-busy` instead.
 */
export function Skeleton({ shape = 'block', className, ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      data-skeleton=""
      className={cn(
        'animate-shimmer bg-linear-to-r from-muted via-hover to-muted bg-[length:200%_100%] motion-reduce:animate-none',
        shape === 'circle' ? 'rounded-full' : 'rounded-sm',
        shape === 'text' && 'h-[1em] w-full',
        className,
      )}
      {...props}
    />
  );
}
