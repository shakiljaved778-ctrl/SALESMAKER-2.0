# SalesMaker 2.0

A multi-tenant, AI-native CRM and sales-execution platform for the whole sales and business-development force.
The specification lives in [`docs/spec/MASTER_SPEC.md`](docs/spec/MASTER_SPEC.md), the working rules in
[`CLAUDE.md`](CLAUDE.md), the decisions in [`docs/adr/`](docs/adr/README.md), and progress in
[`docs/phases/ROADMAP.md`](docs/phases/ROADMAP.md).

## Quick start

Prerequisites: Node.js 24 LTS (see `.nvmrc`), pnpm 10 (`corepack enable`), and Docker.

```bash
pnpm install
pnpm verify        # format check, lint, typecheck, unit tests — must be green before every PR
```

The local stack (`docker compose up`), `pnpm dev` and the seed commands arrive during phase P00. This README grows with them.

## Layout

| Path              | What                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| `apps/`           | Deployable apps: `web`, `api`, `worker`, `realtime`, `control-api`, `fakes`                         |
| `packages/`       | Shared engines and libraries (`@sm/*`)                                                              |
| `packages/config` | Shared ESLint (with the `sm/logical-css` and `sm/design-tokens` rules), Prettier and tsconfig bases |
| `infra/terraform` | AWS infrastructure as code                                                                          |
| `docs/`           | Spec, ADRs, phase plans and handoffs, module docs, runbooks                                         |
