import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { Toast as ToastPrimitive } from 'radix-ui';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { cn } from '../lib/cn.js';

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastInput {
  tone: ToastTone;
  title: string;
  description?: string;
  /** e.g. Undo or View; Undo is offered whenever the operation is reversible (§9.7). */
  action?: { label: string; onClick: () => void };
  /** Defaults: 5 s; errors persist until dismissed (§9.7). Undo toasts use 8 s (§9.11). */
  durationMs?: number;
}

interface ToastEntry extends ToastInput {
  id: number;
}

const ToastContext = createContext<((toast: ToastInput) => void) | null>(null);

/** Show a toast from anywhere inside <ToastProvider>. */
export function useToast(): (toast: ToastInput) => void {
  const show = useContext(ToastContext);
  if (!show) throw new Error('useToast must be used inside <ToastProvider>');
  return show;
}

const ICONS = { success: CircleCheck, error: CircleAlert, info: Info } as const;
const TONE = { success: 'text-success', error: 'text-danger', info: 'text-info' } as const;
export const MAX_VISIBLE_TOASTS = 3;

/**
 * Toasts (§9.7): bottom-start, at most 3 stacked, 5 s by default, errors persist until
 * dismissed, announced politely (assertive for errors) via Radix.
 */
export function ToastProvider({
  children,
  closeLabel,
  viewportLabel,
}: {
  children: ReactNode;
  closeLabel: string;
  viewportLabel: string;
}) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const show = useCallback((toast: ToastInput) => {
    setToasts((current) =>
      [...current, { ...toast, id: Date.now() + Math.random() }].slice(-MAX_VISIBLE_TOASTS),
    );
  }, []);
  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);
  const value = useMemo(() => show, [show]);

  return (
    <ToastContext.Provider value={value}>
      <ToastPrimitive.Provider label={viewportLabel} swipeDirection="left">
        {children}
        {toasts.map((t) => {
          const Icon = ICONS[t.tone];
          const duration =
            t.durationMs ??
            (t.tone === 'error' ? Number.POSITIVE_INFINITY : t.action ? 8000 : 5000);
          return (
            <ToastPrimitive.Root
              key={t.id}
              duration={duration}
              type={t.tone === 'error' ? 'foreground' : 'background'}
              onOpenChange={(open) => {
                if (!open) dismiss(t.id);
              }}
              className="flex w-full items-start gap-3 rounded-md border border-line bg-surface-raised p-3 text-fg shadow-e2 animate-toast-in"
            >
              <Icon aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0', TONE[t.tone])} />
              <div className="min-w-0 flex-1">
                <ToastPrimitive.Title className="text-body-strong">{t.title}</ToastPrimitive.Title>
                {t.description ? (
                  <ToastPrimitive.Description className="text-body-sm text-fg-secondary">
                    {t.description}
                  </ToastPrimitive.Description>
                ) : null}
              </div>
              {t.action ? (
                <ToastPrimitive.Action altText={t.action.label} asChild>
                  <button
                    type="button"
                    onClick={t.action.onClick}
                    className="shrink-0 rounded-sm px-1 text-body-strong text-link hover:underline"
                  >
                    {t.action.label}
                  </button>
                </ToastPrimitive.Action>
              ) : null}
              <ToastPrimitive.Close
                aria-label={closeLabel}
                className="shrink-0 rounded-xs text-fg-secondary hover:text-fg [&_svg]:size-4"
              >
                <X aria-hidden="true" />
              </ToastPrimitive.Close>
            </ToastPrimitive.Root>
          );
        })}
        <ToastPrimitive.Viewport className="fixed bottom-0 start-0 z-[var(--z-toast)] m-0 flex w-full max-w-sm list-none flex-col gap-2 p-4 outline-none" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}
