import { MoreHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn.js';
import { Avatar } from './avatar.js';
import { Button, IconButton } from './button.js';
import { DropdownMenu } from './menu.js';

export interface HighlightsAction {
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  /** At most one action is primary; the rest are secondary. */
  primary?: boolean;
  destructive?: boolean;
  disabled?: boolean;
}

export interface HighlightsField {
  label: string;
  value: ReactNode;
}

export interface HighlightsPanelProps {
  /** The object icon (rendered inside the object's colour chip). */
  icon: ReactNode;
  /** Singular object label above the name (e.g. "Opportunity"). */
  objectLabel: string;
  /** The record name (`title-2`). */
  title: string;
  /** Compact-layout fields shown in a row. */
  fields: HighlightsField[];
  owner?: { name: string; label: string; avatarSrc?: string | undefined } | undefined;
  /** Shown before the actions (e.g. a Follow toggle). */
  follow?: ReactNode;
  actions?: HighlightsAction[];
  moreActionsLabel: string;
  /** A badge next to the name (e.g. "Converted", "Locked"). */
  badge?: ReactNode;
  className?: string;
}

/** How many actions show as buttons before the rest move to the overflow menu (§9.11 T2). */
export const MAX_VISIBLE_ACTIONS = 3;

/** Highlights Panel (§9.11 T2): object chip, record name, compact fields, owner, actions. */
export function HighlightsPanel({
  icon,
  objectLabel,
  title,
  fields,
  owner,
  follow,
  actions = [],
  moreActionsLabel,
  badge,
  className,
}: HighlightsPanelProps) {
  // Destructive actions always go to the overflow menu, last (§9.10 menus).
  const safe = actions.filter((a) => !a.destructive);
  const visible = safe.slice(0, MAX_VISIBLE_ACTIONS);
  const overflow = [...safe.slice(MAX_VISIBLE_ACTIONS), ...actions.filter((a) => a.destructive)];
  return (
    <section
      aria-label={`${objectLabel}: ${title}`}
      className={cn('rounded-md border border-line bg-surface p-4 shadow-e1', className)}
    >
      <div className="flex flex-wrap items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-md bg-cat-1-bg text-cat-1-fg [&_svg]:size-5">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-caption text-fg-secondary">{objectLabel}</p>
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-title-2 text-fg">{title}</h1>
            {badge}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {follow}
          {visible.map((a) => (
            <Button
              key={a.label}
              variant={a.primary ? 'primary' : 'secondary'}
              icon={a.icon}
              disabled={a.disabled}
              onClick={a.onSelect}
            >
              {a.label}
            </Button>
          ))}
          {overflow.length ? (
            <DropdownMenu
              label={moreActionsLabel}
              trigger={
                <IconButton label={moreActionsLabel} variant="secondary">
                  <MoreHorizontal />
                </IconButton>
              }
              items={overflow.map((a) => ({
                type: 'item' as const,
                label: a.label,
                onSelect: a.onSelect,
                ...(a.icon ? { icon: a.icon } : {}),
                ...(a.destructive ? { destructive: true } : {}),
                ...(a.disabled ? { disabled: true } : {}),
              }))}
            />
          ) : null}
        </div>
      </div>
      {fields.length || owner ? (
        <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
          {fields.map((f) => (
            <div key={f.label} className="min-w-0 max-w-64">
              <dt className="truncate text-caption text-fg-secondary">{f.label}</dt>
              <dd className="truncate text-body text-fg">{f.value}</dd>
            </div>
          ))}
          {owner ? (
            <div className="min-w-0">
              <dt className="text-caption text-fg-secondary">{owner.label}</dt>
              <dd className="flex items-center gap-1.5 text-body text-fg">
                <Avatar name={owner.name} src={owner.avatarSrc} size={20} />
                <span className="truncate">{owner.name}</span>
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </section>
  );
}
