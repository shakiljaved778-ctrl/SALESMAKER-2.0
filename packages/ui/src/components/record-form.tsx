import type { ReactNode } from 'react';

import { cn } from '../lib/cn.js';

export interface FormSectionProps {
  /** Section heading from the page layout; omit for an untitled section. */
  title?: string | undefined;
  /** 1 or 2 columns (§9.10 form layout); two columns collapse to one on narrow screens. */
  columns?: 1 | 2;
  children: ReactNode;
  className?: string;
}

/** A page-layout section of form fields: labels above fields, never floating (§9.10). */
export function FormSection({ title, columns = 2, children, className }: FormSectionProps) {
  const grid = (
    <div className={cn('grid gap-x-6 gap-y-4', columns === 2 && 'md:grid-cols-2')}>{children}</div>
  );
  if (!title) return <div className={className}>{grid}</div>;
  return (
    <fieldset className={cn('min-w-0', className)}>
      <legend className="mb-3 w-full border-b border-line-subtle pb-2 text-title-3 text-fg">
        {title}
      </legend>
      {grid}
    </fieldset>
  );
}

/** A full-width cell inside a two-column section (e.g. Description). */
export function FormSpan({ children }: { children: ReactNode }) {
  return <div className="md:col-span-2">{children}</div>;
}

export interface RecordFormProps {
  children: ReactNode;
  /** Sticky footer actions (Cancel, Save & New, Save). */
  footer?: ReactNode;
  /** Form-level errors (e.g. a validation rule without a field) shown above the sections. */
  errors?: ReactNode;
  onSubmit: () => void;
  'aria-label'?: string;
  className?: string;
}

/** Record create/edit form frame: errors banner slot, sections, sticky footer. */
export function RecordForm({
  children,
  footer,
  errors,
  onSubmit,
  className,
  'aria-label': ariaLabel,
}: RecordFormProps) {
  return (
    <form
      noValidate
      aria-label={ariaLabel}
      className={cn('flex min-h-0 flex-col', className)}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="grid min-h-0 flex-1 gap-6 overflow-auto p-1">
        {errors}
        {children}
      </div>
      {footer ? (
        <div className="sticky bottom-0 mt-4 flex justify-end gap-2 border-t border-line bg-surface pt-3">
          {footer}
        </div>
      ) : null}
    </form>
  );
}
