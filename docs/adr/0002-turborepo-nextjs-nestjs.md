# ADR-0002: Turborepo monorepo with Next.js web and NestJS API

- **Status:** Accepted (locked decision #24 in MASTER_SPEC §1.4)
- **Date:** 2026-09-25
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §3.2, §3.3, §13.1

## Context
The product spans a web app, an API, workers, realtime, a control plane and shared engines. Contracts (zod) must be shared between web and API.

## Decision
Use a **Turborepo + pnpm workspaces** monorepo with TypeScript strict (`noUncheckedIndexedAccess`) everywhere, and Python only in `apps/ml`. `apps/web` is Next.js App Router with React 19. `apps/api` is NestJS on the Fastify adapter as a modular monolith, with boundaries enforced by `eslint-plugin-boundaries`. Supporting pieces: `apps/worker` (BullMQ), `apps/realtime`, `apps/control-api`. Shared packages are scoped `@sm/*`. Exact latest-stable versions are pinned in P00 and recorded in an addendum to this ADR. Node is the current LTS, on the same major in CI, Docker and Vercel.

## Consequences
+ One PR can change contract, API and UI atomically, and Turbo remote cache keeps CI fast.
+ Modular monolith now, with the option to extract services later.
− Monorepo tooling discipline is required: boundaries lint and affected-only CI.

## Alternatives rejected
Polyrepo (contract drift); Next.js API routes as the only backend (unsuitable for long-running workers and Fastify performance); tRPC/GraphQL-first (a public REST API is required, ADR-0014).

> Changing this decision requires the owner's approval (§0.3) and a new superseding ADR.
