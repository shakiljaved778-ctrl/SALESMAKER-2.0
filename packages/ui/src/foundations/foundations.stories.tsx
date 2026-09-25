import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  contrast,
  density,
  elevation,
  motion,
  radius,
  semanticTokens,
  spacing,
  typeScale,
  zIndex,
  type SemanticToken,
} from '../tokens/index.js';

const meta: Meta = {
  title: 'Foundations',
  parameters: { layout: 'fullscreen' },
};
export default meta;

const groups: { title: string; prefix: string }[] = [
  { title: 'Backgrounds', prefix: 'bg-' },
  { title: 'Text', prefix: 'text-' },
  { title: 'Borders', prefix: 'border-' },
  { title: 'Actions', prefix: 'action-' },
  { title: 'Status', prefix: 'status-' },
  { title: 'AI (Iris, AI surfaces only)', prefix: 'ai-' },
  { title: 'Categorical (stages, charts, tags)', prefix: 'cat-' },
];

function Swatch({ token }: { token: SemanticToken }) {
  const light = semanticTokens.light[token];
  const dark = semanticTokens.dark[token];
  return (
    <div className="flex items-center gap-3 rounded-md border border-line bg-surface p-2">
      <div
        className="size-10 shrink-0 rounded-sm border border-line"
        style={{ background: `var(--${token})` }}
      />
      <div className="min-w-0">
        <div className="truncate font-mono text-caption text-fg">--{token}</div>
        <div className="font-mono text-caption text-fg-secondary">
          {light} · {dark}
        </div>
      </div>
    </div>
  );
}

export const Colors: StoryObj = {
  render: () => (
    <div className="flex flex-col gap-8">
      <p className="max-w-3xl text-body text-fg-secondary">
        Semantic colour tokens (§9.2). Feature code uses these, never raw values. Switch the theme
        in the toolbar; each card shows its light and dark values. Iris is reserved for AI surfaces.
      </p>
      {groups.map((g) => (
        <section key={g.prefix} className="flex flex-col gap-3">
          <h2 className="text-title-3 text-fg">{g.title}</h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {(Object.keys(semanticTokens.light) as SemanticToken[])
              .filter((t) => t.startsWith(g.prefix))
              .map((t) => (
                <Swatch key={t} token={t} />
              ))}
          </div>
        </section>
      ))}
    </div>
  ),
};

export const Contrast: StoryObj = {
  render: () => {
    const pairs: [SemanticToken, SemanticToken][] = [
      ['text-primary', 'bg-surface'],
      ['text-secondary', 'bg-surface'],
      ['text-tertiary', 'bg-surface'],
      ['text-tertiary', 'bg-canvas'],
      ['action-primary-fg', 'action-primary-bg'],
      ['action-danger-fg', 'action-danger-bg'],
      ['ai-accent', 'ai-bg'],
      ['border-default', 'bg-surface'],
    ];
    return (
      <table className="text-body-sm">
        <thead>
          <tr className="text-start text-label text-fg-secondary">
            <th className="pe-6 text-start">Pair</th>
            <th className="pe-6 text-end">Light</th>
            <th className="text-end">Dark</th>
          </tr>
        </thead>
        <tbody>
          {pairs.map(([fg, bg]) => (
            <tr key={`${fg}/${bg}`} className="border-t border-line-subtle">
              <td className="py-1 pe-6 font-mono">
                {fg} / {bg}
              </td>
              <td className="tabular pe-6 text-end">
                {contrast(semanticTokens.light[fg], semanticTokens.light[bg]).toFixed(2)}
              </td>
              <td className="tabular text-end">
                {contrast(semanticTokens.dark[fg], semanticTokens.dark[bg]).toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  },
};

/** Literal class names: Tailwind only generates classes it can find verbatim in the source. */
const TYPE_CLASS: Record<keyof typeof typeScale, string> = {
  display: 'text-display',
  'title-1': 'text-title-1',
  'title-2': 'text-title-2',
  'title-3': 'text-title-3',
  body: 'text-body',
  'body-strong': 'text-body-strong',
  'body-sm': 'text-body-sm',
  label: 'text-label',
  caption: 'text-caption',
  micro: 'text-micro',
};

export const Typography: StoryObj = {
  render: () => (
    <div className="flex flex-col gap-4">
      {Object.entries(typeScale).map(([name, [size, lh, weight]]) => (
        <div key={name} className="flex items-baseline gap-6 border-b border-line-subtle pb-3">
          <div className="w-40 shrink-0 font-mono text-caption text-fg-secondary">
            {name} · {size}/{lh} · {weight}
          </div>
          <div className={`${TYPE_CLASS[name as keyof typeof typeScale]} text-fg`}>
            Close date can&apos;t be in the past for open deals.
          </div>
        </div>
      ))}
      <p className="tabular text-body text-fg-secondary">
        Tabular figures: 1,250.00 · 98,431.50 · 7.00
      </p>
    </div>
  ),
};

export const SpacingRadiusElevation: StoryObj = {
  name: 'Spacing, radius, elevation',
  render: () => (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-2">
        <h2 className="text-title-3">Spacing (4-px rhythm)</h2>
        {spacing.map((v, i) => (
          <div key={v} className="flex items-center gap-3">
            <span className="w-24 font-mono text-caption text-fg-secondary">
              space-{i} · {v}
            </span>
            <span
              className="h-3 rounded-xs bg-primary"
              style={{ inlineSize: `var(--space-${String(i)})` }}
            />
          </div>
        ))}
      </section>
      <section className="flex flex-wrap gap-4">
        {Object.keys(radius).map((r) => (
          <div
            key={r}
            className="flex size-24 items-center justify-center border border-line bg-surface text-caption"
            style={{ borderRadius: `var(--r-${r})` }}
          >
            r-{r}
          </div>
        ))}
      </section>
      <section className="flex flex-wrap gap-6">
        {Object.keys(elevation.light).map((e) => (
          <div
            key={e}
            className="flex size-28 items-center justify-center rounded-md bg-surface-raised text-caption"
            style={{ boxShadow: `var(--elevation-${e})` }}
          >
            {e}
          </div>
        ))}
      </section>
    </div>
  ),
};

export const DensityAndMotion: StoryObj = {
  name: 'Density, motion, layers',
  render: () => (
    <div className="grid gap-6 lg:grid-cols-3">
      <table className="text-body-sm">
        <tbody>
          {Object.entries(density.default)
            .filter(([, v]) => typeof v === 'number')
            .map(([k]) => (
              <tr key={k}>
                <td className="pe-4 font-mono">{k}</td>
                <td className="tabular">
                  {String(density.comfortable[k as 'row-height'])} /{' '}
                  {String(density.default[k as 'row-height'])} /{' '}
                  {String(density.compact[k as 'row-height'])}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
      <div className="text-body-sm">
        {Object.entries(motion.duration).map(([k, v]) => (
          <div key={k} className="font-mono">
            dur-{k}: {v}ms
          </div>
        ))}
      </div>
      <div className="text-body-sm">
        {Object.entries(zIndex).map(([k, v]) => (
          <div key={k} className="font-mono">
            z-{k}: {v}
          </div>
        ))}
      </div>
    </div>
  ),
};
