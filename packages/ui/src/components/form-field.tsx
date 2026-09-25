'use client';

import { createContext, useContext, useId, type ReactNode } from 'react';

import { cn } from '../lib/cn.js';

interface FormFieldContextValue {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
  disabled: boolean;
}

const FormFieldContext = createContext<FormFieldContextValue | null>(null);

/** Controls read their id and ARIA wiring from the surrounding FormField, if any. */
export function useFormField(): FormFieldContextValue | null {
  return useContext(FormFieldContext);
}

export interface FormFieldProps {
  label: ReactNode;
  /** Helper text below the control; replaced by `error` when present (§9.10 Form layout). */
  helper?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  /** Screen-reader text for the required marker (from i18n). */
  requiredLabel?: string;
  className?: string;
  children: ReactNode;
}

/**
 * Label above the field (never floating), required marked with a danger `*` plus
 * aria-required, helper below, errors replacing the helper (§9.10). Ids and aria-describedby are
 * wired to the control automatically.
 */
export function FormField({
  label,
  helper,
  error,
  required = false,
  disabled = false,
  requiredLabel = 'required',
  className,
  children,
}: FormFieldProps) {
  const id = useId();
  const messageId = `${id}-message`;
  const message = error ?? helper;
  return (
    <FormFieldContext.Provider
      value={{
        id,
        describedBy: message ? messageId : undefined,
        invalid: Boolean(error),
        required,
        disabled,
      }}
    >
      <div className={cn('flex flex-col gap-1', className)}>
        <label
          htmlFor={id}
          className={cn('text-label text-fg-secondary', disabled && 'text-fg-disabled')}
        >
          {label}
          {required ? (
            <span className="ms-0.5 text-danger" aria-hidden="true">
              *
            </span>
          ) : null}
          {required ? <span className="sr-only"> ({requiredLabel})</span> : null}
        </label>
        {children}
        {message ? (
          <p
            id={messageId}
            className={cn('text-caption', error ? 'text-danger' : 'text-fg-secondary')}
            role={error ? 'alert' : undefined}
          >
            {message}
          </p>
        ) : null}
      </div>
    </FormFieldContext.Provider>
  );
}
