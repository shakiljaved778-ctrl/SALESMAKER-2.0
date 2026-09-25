'use client';

import { X } from 'lucide-react';
import {
  Dialog as DialogPrimitive,
  HoverCard as HoverCardPrimitive,
  Popover as PopoverPrimitive,
} from 'radix-ui';
import { useState, type ReactNode } from 'react';

import { cn } from '../lib/cn.js';
import { Button } from './button.js';

const floating =
  'z-[var(--z-popover)] rounded-md border border-line bg-surface-raised text-fg shadow-e2 animate-pop-in';

/** Popover (§9.10): e-2, r-md. */
export function Popover({
  trigger,
  label,
  children,
  align = 'start',
  open,
  onOpenChange,
  className,
}: {
  trigger: ReactNode;
  /** Accessible name of the popover panel (it is exposed as a dialog). */
  label: string;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  return (
    <PopoverPrimitive.Root
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          aria-label={label}
          align={align}
          sideOffset={6}
          className={cn(floating, 'w-72 p-3', className)}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/** Hover card for record previews (§9.10): opens after 300 ms, compact layout inside. */
export function HoverCard({
  trigger,
  children,
  className,
}: {
  trigger: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <HoverCardPrimitive.Root openDelay={300} closeDelay={100}>
      <HoverCardPrimitive.Trigger asChild>{trigger}</HoverCardPrimitive.Trigger>
      <HoverCardPrimitive.Portal>
        <HoverCardPrimitive.Content sideOffset={6} className={cn(floating, 'w-80 p-3', className)}>
          {children}
        </HoverCardPrimitive.Content>
      </HoverCardPrimitive.Portal>
    </HoverCardPrimitive.Root>
  );
}

const DIALOG_SIZES = {
  sm: 'max-w-[400px]',
  md: 'max-w-[560px]',
  lg: 'max-w-[800px]',
  xl: 'max-w-[1040px]',
} as const;
const SHEET_SIZES = { 480: 'max-w-[480px]', 640: 'max-w-[640px]', 800: 'max-w-[800px]' } as const;

export interface DiscardCopy {
  title: string;
  body: string;
  confirm: string;
  cancel: string;
}

interface ModalBaseProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  /** Sticky footer, e.g. Cancel / Save. */
  footer?: ReactNode;
  closeLabel: string;
  /** With unsaved changes, closing (Esc, scrim, ×) first asks to discard them (§9.10, §9.11). */
  dirty?: boolean;
  discardCopy?: DiscardCopy;
}

function useDirtyGuard(dirty: boolean, onOpenChange: (open: boolean) => void) {
  const [confirming, setConfirming] = useState(false);
  const requestChange = (next: boolean) => {
    if (!next && dirty) setConfirming(true);
    else onOpenChange(next);
  };
  return { confirming, setConfirming, requestChange };
}

function DiscardConfirm({
  copy,
  onKeep,
  onDiscard,
}: {
  copy: DiscardCopy;
  onKeep: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-labelledby="sm-discard-title"
      aria-describedby="sm-discard-body"
      className="absolute inset-0 z-10 flex items-center justify-center rounded-[inherit] bg-overlay p-6"
    >
      <div className="w-full max-w-sm rounded-md border border-line bg-surface-raised p-4 shadow-e3">
        <h3 id="sm-discard-title" className="text-title-3 text-fg">
          {copy.title}
        </h3>
        <p id="sm-discard-body" className="mt-1 text-body text-fg-secondary">
          {copy.body}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onKeep} autoFocus>
            {copy.cancel}
          </Button>
          <Button variant="danger" onClick={onDiscard}>
            {copy.confirm}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ModalHeader({
  title,
  description,
  closeLabel,
}: {
  title: ReactNode;
  description?: ReactNode;
  closeLabel: string;
}) {
  return (
    <header className="flex items-start justify-between gap-4 border-b border-line-subtle px-5 py-4">
      <div className="min-w-0">
        <DialogPrimitive.Title className="text-title-2 text-fg">{title}</DialogPrimitive.Title>
        {description ? (
          <DialogPrimitive.Description className="mt-0.5 text-body-sm text-fg-secondary">
            {description}
          </DialogPrimitive.Description>
        ) : null}
      </div>
      <DialogPrimitive.Close asChild>
        <Button variant="ghost" size="sm" aria-label={closeLabel} className="w-7 px-0">
          <X aria-hidden="true" />
        </Button>
      </DialogPrimitive.Close>
    </header>
  );
}

/** Modal dialog (§9.10): sm/md/lg/xl, scrollable body, sticky footer, focus trap, Esc closes. */
export function Dialog({
  size = 'md',
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  closeLabel,
  dirty = false,
  discardCopy,
}: ModalBaseProps & { size?: keyof typeof DIALOG_SIZES }) {
  const guard = useDirtyGuard(dirty, onOpenChange);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={guard.requestChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[var(--z-modal)] bg-overlay animate-fade-in" />
        <DialogPrimitive.Content
          {...(description ? {} : { 'aria-describedby': undefined })}
          className={cn(
            'fixed start-1/2 top-1/2 z-[var(--z-modal)] flex max-h-[85dvh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-line bg-surface-raised shadow-e3 animate-pop-in rtl:translate-x-1/2',
            DIALOG_SIZES[size],
          )}
        >
          <ModalHeader title={title} description={description} closeLabel={closeLabel} />
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? (
            <footer className="flex justify-end gap-2 border-t border-line-subtle px-5 py-3">
              {footer}
            </footer>
          ) : null}
          {guard.confirming && discardCopy ? (
            <DiscardConfirm
              copy={discardCopy}
              onKeep={() => {
                guard.setConfirming(false);
              }}
              onDiscard={() => {
                guard.setConfirming(false);
                onOpenChange(false);
              }}
            />
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Side sheet at the inline end (§9.10): 480/640/800, for quick views and create forms. */
export function Sheet({
  size = 480,
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  closeLabel,
  dirty = false,
  discardCopy,
}: ModalBaseProps & { size?: keyof typeof SHEET_SIZES }) {
  const guard = useDirtyGuard(dirty, onOpenChange);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={guard.requestChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[var(--z-sheet)] bg-overlay animate-fade-in" />
        <DialogPrimitive.Content
          {...(description ? {} : { 'aria-describedby': undefined })}
          className={cn(
            'fixed inset-y-0 end-0 z-[var(--z-sheet)] flex w-full flex-col border-s border-line bg-surface-raised shadow-e3 animate-sheet-in rtl:animate-sheet-in-rtl',
            SHEET_SIZES[size],
          )}
        >
          <ModalHeader title={title} description={description} closeLabel={closeLabel} />
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? (
            <footer className="flex justify-end gap-2 border-t border-line-subtle px-5 py-3">
              {footer}
            </footer>
          ) : null}
          {guard.confirming && discardCopy ? (
            <DiscardConfirm
              copy={discardCopy}
              onKeep={() => {
                guard.setConfirming(false);
              }}
              onDiscard={() => {
                guard.setConfirming(false);
                onOpenChange(false);
              }}
            />
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
