# ADR-0016: UI stack: shadcn/ui + Radix + Tailwind v4 wrapped as @sm/ui

- **Status:** Accepted (locked decision #21 in MASTER_SPEC §1.4)
- **Date:** 2026-09-25
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §3.2, §9.10

## Context
We need accessible primitives and full visual control.

## Decision
Tailwind CSS v4 (tokens as CSS variables mapped via `@theme`), Radix Primitives and shadcn/ui sources, wrapped and restyled as `@sm/ui`, which has no data fetching. Around it: TanStack Table + Virtual for grids, React Hook Form + zod for forms, dnd-kit, React Flow, Recharts via shadcn charts (ECharts for series over 5k points) and Lucide icons.

## Consequences
+ Accessible by default, and we own the component code.
− We maintain the forked shadcn sources ourselves.

## Alternatives rejected
MUI/Chakra (harder to match SDL density); fully custom primitives (a11y cost).

> Changing this decision requires the owner's approval (§0.3) and a new superseding ADR.
