'use client';

import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';

import { cn } from '../lib/cn.js';
import { Button } from './button.js';

export interface PathStage {
  value: string;
  label: string;
  /** Path settings (§5.6): key fields and guidance for success, shown in the drawer. */
  keyFields?: { label: string; value: ReactNode }[];
  guidance?: ReactNode;
}

export interface PathLabels {
  /** Accessible name of the stage list (e.g. "Opportunity stage"). */
  path: string;
  /** Screen-reader state suffixes. */
  completed: string;
  current: string;
  markComplete: string;
  markCurrent: string;
  showGuidance: string;
  hideGuidance: string;
  keyFields: string;
  guidance: string;
  /** Announced while a stage change saves. */
  saving: string;
}

export interface PathProps {
  stages: PathStage[];
  /** The record's current stage value. */
  current: string;
  labels: PathLabels;
  /** Advance to the stage after the current one. Omit to hide the action (read-only record). */
  onMarkComplete?: (() => void) | undefined;
  /** Move the record to the stage the user selected in the bar. */
  onMarkCurrent?: ((stage: string) => void) | undefined;
  /** A save is in flight; the action button shows its loading state. */
  busy?: boolean | undefined;
  defaultGuidanceOpen?: boolean | undefined;
  className?: string;
}

/**
 * Path stage bar (§9.10): chevrons toward the inline end; completed stages are jade with a check,
 * the current stage is the selected tint with brand text, future stages are muted. Selecting a stage
 * previews its key fields and guidance; the action marks the current stage complete or moves to the
 * selected one.
 */
export function Path({
  stages,
  current,
  labels,
  onMarkComplete,
  onMarkCurrent,
  busy,
  defaultGuidanceOpen = false,
  className,
}: PathProps) {
  const [selected, setSelected] = useState(current);
  // A saved stage change moves the selection with it.
  useEffect(() => {
    setSelected(current);
  }, [current]);
  const [open, setOpen] = useState(defaultGuidanceOpen);
  const drawerId = useId();
  const currentIndex = stages.findIndex((s) => s.value === current);
  const focus = stages.find((s) => s.value === selected) ?? stages[currentIndex];
  const isLast = currentIndex === stages.length - 1;
  const hasDrawer = Boolean(focus && (focus.guidance || focus.keyFields?.length));
  const action =
    selected !== current && onMarkCurrent ? (
      <Button
        variant="primary"
        loading={busy ?? false}
        loadingLabel={labels.saving}
        onClick={() => {
          onMarkCurrent(selected);
        }}
      >
        {labels.markCurrent}
      </Button>
    ) : onMarkComplete && !isLast ? (
      <Button
        variant="primary"
        icon={<Check />}
        loading={busy ?? false}
        loadingLabel={labels.saving}
        onClick={onMarkComplete}
      >
        {labels.markComplete}
      </Button>
    ) : null;

  return (
    <section className={cn('rounded-md border border-line bg-surface p-3 shadow-e1', className)}>
      <div className="flex flex-wrap items-center gap-3">
        <ol aria-label={labels.path} className="flex w-full min-w-0 gap-0.5">
          {stages.map((stage, i) => {
            const state =
              i < currentIndex ? 'completed' : i === currentIndex ? 'current' : 'future';
            const isSelected = stage.value === selected;
            return (
              <li key={stage.value} className="min-w-0 flex-1">
                <button
                  type="button"
                  aria-current={state === 'current' ? 'step' : undefined}
                  aria-pressed={isSelected}
                  data-state={state}
                  onClick={() => {
                    setSelected(stage.value);
                  }}
                  className={cn(
                    'flex h-8 w-full min-w-0 items-center justify-center gap-1 px-4 text-body-sm font-medium transition-colors duration-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus [&_svg]:size-3.5 [&_svg]:shrink-0',
                    i === 0 ? 'path-chevron-first rounded-s-sm' : 'path-chevron -ms-2',
                    state === 'completed' && 'bg-primary text-on-primary hover:bg-primary-hover',
                    state === 'current' && 'bg-selected text-link',
                    state === 'future' && 'bg-muted text-fg-secondary hover:bg-hover',
                    isSelected && state !== 'current' && 'underline underline-offset-4',
                  )}
                >
                  {state === 'completed' ? <Check aria-hidden /> : null}
                  <span className="truncate">{stage.label}</span>
                  {state === 'completed' ? (
                    <span className="sr-only">({labels.completed})</span>
                  ) : state === 'current' ? (
                    <span className="sr-only">({labels.current})</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ol>
        {hasDrawer || action ? (
          <div className="flex w-full items-center justify-end gap-2">
            {hasDrawer ? (
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={open}
                aria-controls={drawerId}
                onClick={() => {
                  setOpen((o) => !o);
                }}
              >
                {open ? labels.hideGuidance : labels.showGuidance}
                <ChevronDown
                  aria-hidden
                  className={cn('transition-transform', open && 'rotate-180')}
                />
              </Button>
            ) : null}
            {action}
          </div>
        ) : null}
      </div>
      {hasDrawer && open && focus ? (
        <div
          id={drawerId}
          className="mt-3 grid gap-4 border-t border-line-subtle pt-3 md:grid-cols-2"
        >
          {focus.keyFields?.length ? (
            <div>
              <h3 className="mb-2 text-label text-fg-secondary">{labels.keyFields}</h3>
              <dl className="grid gap-2">
                {focus.keyFields.map((f) => (
                  <div key={f.label} className="flex gap-2">
                    <dt className="w-40 shrink-0 truncate text-body-sm text-fg-secondary">
                      {f.label}
                    </dt>
                    <dd className="min-w-0 text-body-sm text-fg">{f.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
          {focus.guidance ? (
            <div>
              <h3 className="mb-2 text-label text-fg-secondary">{labels.guidance}</h3>
              <div className="text-body-sm text-fg">{focus.guidance}</div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
