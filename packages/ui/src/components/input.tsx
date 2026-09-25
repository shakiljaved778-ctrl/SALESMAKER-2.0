'use client';

import { X } from 'lucide-react';
import {
  forwardRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';

import { cn } from '../lib/cn.js';
import { useFormField } from './form-field.js';

const fieldFrame =
  'flex w-full items-center gap-2 rounded-sm border border-line bg-surface px-2.5 text-body text-fg transition-colors duration-100 hover:border-line-strong focus-within:border-focus aria-invalid:border-danger has-[:disabled]:bg-muted has-[:disabled]:text-fg-disabled';

function useFieldAria(props: {
  id?: string | undefined;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling' | undefined;
  disabled?: boolean | undefined;
  required?: boolean | undefined;
}) {
  const field = useFormField();
  return {
    id: props.id ?? field?.id,
    'aria-describedby':
      [props['aria-describedby'], field?.describedBy].filter(Boolean).join(' ') || undefined,
    'aria-invalid': props['aria-invalid'] ?? (field?.invalid ? true : undefined),
    'aria-required': (props.required ?? field?.required) ? true : undefined,
    disabled: props.disabled ?? field?.disabled,
  };
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  prefix?: ReactNode;
  suffix?: ReactNode;
  /** Shows a clear button while there is a value. Needs a label for the button (from i18n). */
  onClear?: () => void;
  clearLabel?: string;
  /** Shows "used / max" when maxLength is set. */
  showCount?: boolean;
}

/**
 * Input (§9.10): 1px border, r-sm, prefix/suffix slots, clear button, character counter;
 * invalid (danger border), disabled, and read-only (no border, text only) states.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    className,
    prefix,
    suffix,
    onClear,
    clearLabel = 'Clear',
    showCount = false,
    readOnly,
    value,
    defaultValue,
    onChange,
    maxLength,
    ...props
  },
  ref,
) {
  const aria = useFieldAria(props);
  const [length, setLength] = useState(String(value ?? defaultValue ?? '').length);
  const current = value === undefined ? length : String(value).length;
  if (readOnly) {
    return (
      <input
        ref={ref}
        readOnly
        value={value}
        defaultValue={defaultValue}
        className={cn(
          'h-[var(--control-height)] w-full bg-transparent text-body text-fg outline-offset-2',
          className,
        )}
        {...props}
        {...aria}
      />
    );
  }
  return (
    <div
      className={cn(fieldFrame, 'h-[var(--control-height)]', className)}
      aria-invalid={aria['aria-invalid']}
    >
      {prefix ? (
        <span className="flex shrink-0 text-fg-secondary [&_svg]:size-4">{prefix}</span>
      ) : null}
      <input
        ref={ref}
        value={value}
        defaultValue={defaultValue}
        maxLength={maxLength}
        onChange={(e) => {
          setLength(e.target.value.length);
          onChange?.(e);
        }}
        className="h-full min-w-0 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-fg-secondary disabled:cursor-not-allowed"
        {...props}
        {...aria}
      />
      {onClear && current > 0 ? (
        <button
          type="button"
          onClick={onClear}
          aria-label={clearLabel}
          className="flex shrink-0 rounded-xs text-fg-secondary hover:text-fg [&_svg]:size-4"
        >
          <X aria-hidden="true" />
        </button>
      ) : null}
      {showCount && maxLength ? (
        <span className="tabular shrink-0 text-caption text-fg-secondary" aria-live="polite">
          {current}/{maxLength}
        </span>
      ) : null}
      {suffix ? (
        <span className="flex shrink-0 text-fg-secondary [&_svg]:size-4">{suffix}</span>
      ) : null}
    </div>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  showCount?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, showCount = false, maxLength, value, defaultValue, onChange, readOnly, ...props },
  ref,
) {
  const aria = useFieldAria(props);
  const [length, setLength] = useState(String(value ?? defaultValue ?? '').length);
  const current = value === undefined ? length : String(value).length;
  return (
    <div className="flex flex-col gap-1">
      <textarea
        ref={ref}
        value={value}
        defaultValue={defaultValue}
        maxLength={maxLength}
        readOnly={readOnly}
        onChange={(e) => {
          setLength(e.target.value.length);
          onChange?.(e);
        }}
        className={cn(
          readOnly
            ? 'w-full resize-none bg-transparent text-body text-fg'
            : 'min-h-20 w-full rounded-sm border border-line bg-surface px-2.5 py-1.5 text-body text-fg outline-none transition-colors duration-100 placeholder:text-fg-secondary hover:border-line-strong focus-visible:border-focus aria-invalid:border-danger disabled:cursor-not-allowed disabled:bg-muted disabled:text-fg-disabled',
          className,
        )}
        {...props}
        {...aria}
      />
      {showCount && maxLength ? (
        <span className="tabular self-end text-caption text-fg-secondary" aria-live="polite">
          {current}/{maxLength}
        </span>
      ) : null}
    </div>
  );
});
