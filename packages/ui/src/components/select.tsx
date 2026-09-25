import { Check, ChevronDown } from 'lucide-react';
import { Select as SelectPrimitive } from 'radix-ui';
import type { ReactNode } from 'react';

import { cn } from '../lib/cn.js';
import { useFormField } from './form-field.js';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  'aria-label'?: string;
  className?: string;
}

/**
 * Select (§9.10) for short lists. Past 7 options, use Combobox, which is searchable.
 * Radix handles keyboard, typeahead and focus; it inherits FormField wiring.
 */
export function Select({ options, placeholder, className, disabled, ...props }: SelectProps) {
  const field = useFormField();
  return (
    <SelectPrimitive.Root {...props} disabled={disabled ?? field?.disabled}>
      <SelectPrimitive.Trigger
        id={field?.id}
        aria-label={props['aria-label']}
        aria-describedby={field?.describedBy}
        aria-invalid={field?.invalid || undefined}
        className={cn(
          'flex h-[var(--control-height)] w-full items-center justify-between gap-2 rounded-sm border border-line bg-surface px-2.5 text-start text-body text-fg hover:border-line-strong aria-invalid:border-danger data-[placeholder]:text-fg-secondary disabled:cursor-not-allowed disabled:bg-muted disabled:text-fg-disabled [&_svg]:size-4',
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon className="text-fg-secondary">
          <ChevronDown aria-hidden="true" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className="z-[var(--z-popover)] max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-line bg-surface-raised p-1 shadow-e2"
        >
          <SelectPrimitive.Viewport>
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </SelectItem>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

function SelectItem({
  value,
  disabled,
  children,
}: {
  value: string;
  disabled?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <SelectPrimitive.Item
      value={value}
      disabled={disabled}
      className="relative flex h-8 cursor-default select-none items-center rounded-sm pe-8 ps-2 text-body text-fg outline-none data-[disabled]:text-fg-disabled data-[highlighted]:bg-hover"
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute end-2 text-primary [&_svg]:size-4">
        <Check aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}
