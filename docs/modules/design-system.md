# Design system (`@sm/ui`)

Spec: §9 · ADRs: 0015, 0016, 0017, 0018 · Package: `packages/ui` · Storybook: published from `main` to GitHub Pages

## Tokens

- The §9 values live in TypeScript (`src/tokens/`): palette, semantic light and dark colours (translucent values
  pre-composited so contrast can be checked), type scale, density, spacing, radius, elevation, motion, z-index.
- `pnpm --filter @sm/ui tokens` writes `src/styles/tokens.css`. **Never edit it by hand**; a test fails if it drifts.
- `src/styles/index.css` maps tokens into Tailwind v4 with `@theme inline`, so utilities read CSS variables and theme
  and density switch at runtime through `data-theme` / `data-density` on `<html>`, with no CSS regeneration.
- `test/tokens.contrast.test.ts` checks 100+ text/background pairs in both themes (WCAG 2.2 AA). Locked values below
  the rule are listed as explicit pending exceptions (OPEN_QUESTIONS Q27–Q29), never changed silently.
- Feature code uses semantic tokens only: the `sm/design-tokens` lint rule rejects raw colours and px font sizes, and
  `sm/logical-css` rejects physical `ml-/mr-/left-/right-` utilities (RTL readiness, golden rules 5 and 6).
- **Iris is reserved for AI** (the `ai` variants and surfaces). Jade is the brand colour for primary actions, focus and
  selection. The auth brand panel uses `bg-brand-from` → `bg-brand-to` (Jade 700 → 900).

## Components

27 components: form controls (FormField, Button, IconButton, Input, Textarea, Checkbox, RadioGroup, Switch), selection
and display (Select, Combobox, StatusChip, Avatar, Tooltip, Kbd, Separator, Card), overlays and navigation (Popover,
HoverCard, Dialog, Sheet, DropdownMenu with radio groups, Tabs, Toasts) and feedback (Banner, EmptyState, Skeleton,
CommandPalette with fuzzy matching).

Rules that keep them usable from Next.js and accessible:

- Modules that use hooks, context, Radix or cmdk start with `'use client'` (guarded by `test/client-boundary.test.ts`),
  so Server Components can import from the barrel.
- Every user-visible string is a prop: components never hard-code copy (golden rule 5).
- `IconButton` requires `label`, which becomes the accessible name and the tooltip.
- Use literal class maps, never template-built class names: Tailwind only generates classes it can see.

## Stories and checks

Every story runs in five variants (light/dark × default/compact, plus RTL with the `ar-XB` pseudo-locale):

```bash
pnpm --filter @sm/ui build-storybook
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium SKIP_VISUAL=1 pnpm --filter @sm/ui test:stories   # axe, blocking
pnpm --filter @sm/ui test:stories -- --update-snapshots                                       # refresh baselines
```

axe serious/critical violations fail CI. Screenshots are compared with the committed baselines in a separate,
non-blocking step: review the diffs in the uploaded report and update baselines deliberately.

## In the app

`apps/web` imports `@sm/ui/styles.css` once, sets the font variables from `next/font/local`, and renders
`data-theme`, `data-density`, `lang` and `dir` on `<html>` from preference cookies (the profile is the source of
truth). `system` resolves in CSS through `prefers-color-scheme`, so the first paint is right without a script.
