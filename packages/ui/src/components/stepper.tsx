import { Check } from 'lucide-react';

import { cn } from '../lib/cn.js';

export interface StepperStep {
  key: string;
  label: string;
}

export interface StepperProps {
  steps: StepperStep[];
  /** Index of the current step. */
  current: number;
  /** Accessible name of the list (e.g. "Import steps"). */
  label: string;
  /** Screen-reader suffixes for done and current steps. */
  completedLabel: string;
  currentLabel: string;
  className?: string;
}

/**
 * Wizard stepper (§9 T6): numbered steps along the top of the wizard column. Done steps are jade
 * with a check, the current step is outlined in brand with `aria-current="step"`, later steps are
 * muted. Labels hide below `sm` and the current label stays visible.
 */
export function Stepper({
  steps,
  current,
  label,
  completedLabel,
  currentLabel,
  className,
}: StepperProps) {
  return (
    <nav aria-label={label} className={className}>
      <ol className="flex items-center gap-2">
        {steps.map((step, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <li key={step.key} className="flex min-w-0 flex-1 items-center gap-2 last:flex-none">
              <span
                aria-current={active ? 'step' : undefined}
                className="flex min-w-0 items-center gap-2"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-full border text-caption font-medium tabular [&_svg]:size-3.5',
                    done && 'border-primary bg-primary text-on-primary',
                    active && 'border-primary bg-selected text-primary',
                    !done && !active && 'border-line-strong text-fg-secondary',
                  )}
                >
                  {done ? <Check /> : i + 1}
                </span>
                <span
                  className={cn(
                    'truncate text-body-sm',
                    active ? 'font-medium text-fg' : 'hidden text-fg-secondary sm:inline',
                  )}
                >
                  {step.label}
                  {done ? <span className="sr-only">, {completedLabel}</span> : null}
                  {active ? <span className="sr-only">, {currentLabel}</span> : null}
                </span>
              </span>
              {i < steps.length - 1 ? (
                <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-line" />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
