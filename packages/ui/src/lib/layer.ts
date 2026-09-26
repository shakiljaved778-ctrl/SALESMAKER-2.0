import { createContext, useContext } from 'react';

/** The overlay a component renders inside, if any (§9.10 z-scale). */
export type OverlayLayer = 'sheet' | 'modal' | null;

export const OverlayLayerContext = createContext<OverlayLayer>(null);

// Static class strings so Tailwind sees them. A popover opened from inside a sheet or modal must
// stack just above that overlay, not at the page-level popover layer beneath it.
const LAYER_CLASS: Record<'page' | 'sheet' | 'modal', string> = {
  page: 'z-[var(--z-popover)]',
  sheet: 'z-[calc(var(--z-sheet)+1)]',
  modal: 'z-[calc(var(--z-modal)+1)]',
};

/** z-index class for popovers, menus, selects and hover cards at the current overlay layer. */
export function usePopoverLayerClass(): string {
  return LAYER_CLASS[useContext(OverlayLayerContext) ?? 'page'];
}
