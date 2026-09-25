/** Non-colour tokens (§9.3–§9.5, §9.9). */

/** Type scale: size/line-height in px and weight, at Default density (§9.3). */
export const typeScale = {
  display: [28, 34, 650],
  'title-1': [22, 28, 600],
  'title-2': [18, 24, 600],
  'title-3': [15, 22, 600],
  body: [14, 20, 400],
  'body-strong': [14, 20, 550],
  'body-sm': [13, 18, 400],
  label: [12, 16, 500],
  caption: [12, 16, 400],
  micro: [11, 14, 500],
} as const;

/** Density modes (§9.3, §9.5). Only these tokens change between densities. */
export const density = {
  comfortable: {
    'row-height': 44,
    'control-height': 40,
    'page-padding': 32,
    'card-padding': 20,
    'field-gap': 16,
    'kanban-card-padding': 12,
    body: [14, 20],
    'body-sm': [13, 18],
    cell: [14, 20],
  },
  default: {
    'row-height': 36,
    'control-height': 32,
    'page-padding': 24,
    'card-padding': 16,
    'field-gap': 12,
    'kanban-card-padding': 10,
    body: [14, 20],
    'body-sm': [13, 18],
    cell: [13, 18],
  },
  compact: {
    'row-height': 28,
    'control-height': 28,
    'page-padding': 16,
    'card-padding': 12,
    'field-gap': 8,
    'kanban-card-padding': 8,
    body: [13, 18],
    'body-sm': [12, 16],
    cell: [12, 16],
  },
} as const;

/** 4-px rhythm spacing scale (§9.4): token `space-N` = value. */
export const spacing = [0, 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80] as const;

export const controlHeights = { sm: 28, md: 32, lg: 40, touch: 44 } as const;

export const radius = { xs: 4, sm: 6, md: 8, lg: 12, full: 9999 } as const;

export const elevation = {
  light: {
    'e-1': '0 1px 2px rgba(20, 24, 30, 0.06)',
    'e-2': '0 4px 12px rgba(20, 24, 30, 0.08), 0 1px 3px rgba(20, 24, 30, 0.06)',
    'e-3': '0 16px 40px rgba(20, 24, 30, 0.16)',
  },
  // Dark: shadows at 40% opacity; lighter surfaces and a 1px border carry the elevation.
  dark: {
    'e-1': '0 1px 2px rgba(0, 0, 0, 0.24)',
    'e-2': '0 4px 12px rgba(0, 0, 0, 0.32), 0 1px 3px rgba(0, 0, 0, 0.24)',
    'e-3': '0 16px 40px rgba(0, 0, 0, 0.64)',
  },
} as const;

export const motion = {
  duration: { fast: 100, base: 160, slow: 240 },
  easing: { standard: 'cubic-bezier(0.2, 0, 0, 1)', exit: 'cubic-bezier(0.4, 0, 1, 1)' },
} as const;

export const zIndex = {
  base: 0,
  sticky: 10,
  sidebar: 20,
  popover: 40,
  softphone: 50,
  sheet: 60,
  modal: 70,
  palette: 80,
  toast: 90,
  tooltip: 100,
} as const;

export const breakpoints = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  '2xl': 1536,
  '3xl': 1920,
} as const;

export const fonts = {
  sans: "'Inter Variable', Inter, 'IBM Plex Sans Arabic', -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
} as const;
