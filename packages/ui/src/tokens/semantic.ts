import { mix } from './color.js';
import { categorical, palette as p } from './palette.js';

export type Theme = 'light' | 'dark';

/**
 * Semantic colour tokens (§9.2) for each theme, resolved to opaque hex so they can be checked
 * for contrast. Values given as "12% alpha of X over surface" are pre-composited here.
 */
function semantic(theme: Theme) {
  const light = theme === 'light';
  const surface = light ? '#FFFFFF' : p.graphite[900];
  const t = {
    'bg-canvas': light ? p.graphite[50] : p.graphite[950],
    'bg-surface': surface,
    'bg-surface-raised': light ? '#FFFFFF' : p.graphite[850],
    'bg-subtle': light ? p.graphite[25] : '#171B22',
    'bg-muted': light ? p.graphite[100] : p.graphite[800],
    'bg-hover': light ? p.graphite[100] : '#1F252E',
    'bg-selected': light ? p.jade[50] : '#0F2E2A',
    'bg-sidebar': light ? p.graphite[900] : '#0A0D10',
    'border-subtle': light ? p.graphite[100] : '#20262F',
    'border-default': light ? p.graphite[200] : '#2A313B',
    'border-strong': light ? p.graphite[300] : '#3A424E',
    'border-focus': light ? p.jade[500] : p.jade[400],
    'text-primary': light ? p.graphite[900] : '#E8EBEF',
    'text-secondary': light ? p.graphite[600] : '#A9B1BC',
    'text-tertiary': light ? p.graphite[500] : '#7D8693',
    'text-disabled': light ? p.graphite[400] : '#525A66',
    'text-inverse': light ? '#FFFFFF' : p.graphite[950],
    'text-link': light ? p.jade[700] : p.jade[300],
    'text-on-sidebar': '#E8EBEF',
    // T9 auth brand panel (§9.8): Jade 700 → 900 gradient in both themes, light text on it.
    'bg-brand-from': p.jade[700],
    'bg-brand-to': p.jade[900],
    'text-on-brand': '#FFFFFF',
    'text-on-brand-muted': p.jade[100],
    'text-on-sidebar-muted': p.graphite[400],
    'action-primary-bg': light ? p.jade[600] : p.jade[400],
    'action-primary-hover': light ? p.jade[700] : p.jade[300],
    'action-primary-active': light ? p.jade[800] : p.jade[200],
    'action-primary-fg': light ? '#FFFFFF' : p.jade[950],
    'action-secondary-bg': light ? '#FFFFFF' : p.graphite[850],
    'action-secondary-border': light ? p.graphite[200] : '#2A313B',
    'action-secondary-fg': light ? p.graphite[800] : '#E8EBEF',
    'action-danger-bg': light ? p.danger[600] : p.danger[500],
    'action-danger-fg': '#FFFFFF',
    'status-success-fg': light ? p.success[700] : '#5CC48F',
    'status-warning-fg': light ? p.warning[700] : '#F0B458',
    'status-danger-fg': light ? p.danger[700] : '#F2847E',
    'status-info-fg': light ? p.info[700] : '#7FB0F0',
    'status-success-bg': light ? p.success[50] : mix(p.success[500], 0.12, surface),
    'status-warning-bg': light ? p.warning[50] : mix(p.warning[500], 0.12, surface),
    'status-danger-bg': light ? p.danger[50] : mix(p.danger[500], 0.12, surface),
    'status-info-bg': light ? p.info[50] : mix(p.info[500], 0.12, surface),
    // Neutral status (e.g. Lost): graphite-600 on graphite-100 in light (spec v1.2).
    'status-neutral-fg': light ? p.graphite[600] : '#A9B1BC',
    'status-neutral-bg': light ? p.graphite[100] : p.graphite[800],
    'ai-accent': light ? p.iris[600] : p.iris[300],
    'ai-bg': light ? p.iris[50] : mix(p.iris[500], 0.14, surface),
    'ai-border': light ? p.iris[200] : p.iris[700],
  } satisfies Record<string, string>;

  const cats: Record<string, string> = {};
  for (const c of categorical) {
    cats[`cat-${String(c.slot)}-solid`] = c.base;
    cats[`cat-${String(c.slot)}-bg`] = mix(c.base, light ? 0.12 : 0.18, surface);
    cats[`cat-${String(c.slot)}-fg`] = light
      ? mix(c.base, 0.62, '#000000')
      : mix(c.base, 0.55, '#FFFFFF');
  }
  return { ...t, ...cats };
}

export const semanticTokens = { light: semantic('light'), dark: semantic('dark') } as const;
export type SemanticToken = keyof ReturnType<typeof semantic>;

/** Modal scrim: translucent by design, so it is not part of the contrast-checked set. */
export const overlay = { light: 'rgba(12, 15, 19, 0.48)', dark: 'rgba(0, 0, 0, 0.64)' } as const;
