import { Check, Minus } from 'lucide-react';
import {
  Checkbox as CheckboxPrimitive,
  RadioGroup as RadioPrimitive,
  Switch as SwitchPrimitive,
} from 'radix-ui';
import { forwardRef, useId, type ComponentPropsWithoutRef, type ReactNode } from 'react';

import { cn } from '../lib/cn.js';

function ChoiceLabel({
  htmlFor,
  children,
  disabled,
}: {
  htmlFor: string;
  children: ReactNode;
  disabled?: boolean | undefined;
}) {
  return (
    <label htmlFor={htmlFor} className={cn('text-body text-fg', disabled && 'text-fg-disabled')}>
      {children}
    </label>
  );
}

export interface CheckboxProps extends ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root> {
  label?: ReactNode;
}

/** Checkbox (Radix): checked, unchecked, indeterminate; r-xs; 16px box in a 24px target. */
export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(function Checkbox(
  { label, id, className, ...props },
  ref,
) {
  const autoId = useId();
  const controlId = id ?? autoId;
  return (
    <div className="inline-flex min-h-6 items-center gap-2">
      <CheckboxPrimitive.Root
        ref={ref}
        id={controlId}
        className={cn(
          'peer flex size-4 shrink-0 items-center justify-center rounded-xs border border-line-strong bg-surface text-on-primary transition-colors duration-100 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      >
        <CheckboxPrimitive.Indicator className="[&_svg]:size-3">
          {props.checked === 'indeterminate' ? (
            <Minus aria-hidden="true" />
          ) : (
            <Check aria-hidden="true" />
          )}
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      {label ? (
        <ChoiceLabel htmlFor={controlId} disabled={props.disabled}>
          {label}
        </ChoiceLabel>
      ) : null}
    </div>
  );
});

export const RadioGroup = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof RadioPrimitive.Root>
>(function RadioGroup({ className, ...props }, ref) {
  return (
    <RadioPrimitive.Root ref={ref} className={cn('flex flex-col gap-2', className)} {...props} />
  );
});

export interface RadioProps extends ComponentPropsWithoutRef<typeof RadioPrimitive.Item> {
  label: ReactNode;
}

export const Radio = forwardRef<HTMLButtonElement, RadioProps>(function Radio(
  { label, id, className, ...props },
  ref,
) {
  const autoId = useId();
  const controlId = id ?? autoId;
  return (
    <div className="inline-flex min-h-6 items-center gap-2">
      <RadioPrimitive.Item
        ref={ref}
        id={controlId}
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded-full border border-line-strong bg-surface data-[state=checked]:border-primary disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      >
        <RadioPrimitive.Indicator className="size-2 rounded-full bg-primary" />
      </RadioPrimitive.Item>
      <ChoiceLabel htmlFor={controlId} disabled={props.disabled}>
        {label}
      </ChoiceLabel>
    </div>
  );
});

export interface SwitchProps extends ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> {
  label?: ReactNode;
}

/** Switch (Radix). The thumb moves with logical properties, so it mirrors in RTL. */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { label, id, className, ...props },
  ref,
) {
  const autoId = useId();
  const controlId = id ?? autoId;
  return (
    <div className="inline-flex min-h-6 items-center gap-2">
      <SwitchPrimitive.Root
        ref={ref}
        id={controlId}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent bg-line-strong transition-colors duration-100 data-[state=checked]:bg-primary disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      >
        <SwitchPrimitive.Thumb className="block size-4 translate-x-0.5 rounded-full bg-surface shadow-e1 transition-transform duration-100 data-[state=checked]:translate-x-4 rtl:-translate-x-0.5 rtl:data-[state=checked]:-translate-x-4" />
      </SwitchPrimitive.Root>
      {label ? (
        <ChoiceLabel htmlFor={controlId} disabled={props.disabled}>
          {label}
        </ChoiceLabel>
      ) : null}
    </div>
  );
});
