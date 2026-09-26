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

### Run it locally

```bash
docker compose up -d     # Postgres 16, Valkey, SeaweedFS (S3), Mailpit, OTel + Jaeger
pnpm setup:dev           # dev keys in .secrets/ and a .env (idempotent)
pnpm db:setup            # roles, extensions and migrations for the cell and control-plane databases
pnpm dev                 # api :4000, control-api :4100, fakes :4200, web :3000
pnpm db:seed             # demo workspaces pixelcraft-demo and aurelia-demo (needs the control API up)
```

The apex is http://localhost:3000 (sign up, find your workspace), and each workspace lives at
`http://{slug}.localhost:3000`: the web app resolves the host through the control plane to the workspace's cell.
Chromium and Firefox resolve `*.localhost` to loopback with no hosts-file changes.

Mail sent locally lands in Mailpit at http://localhost:8025, and nothing is delivered. "Continue with Google/Microsoft"
uses the fake identity providers in `apps/fakes`. In restricted networks where the Postgres image cannot install
packages, use `docker compose -f docker-compose.yml -f docker-compose.sandbox.yml up -d`.

## Layout

| Path              | What                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| `apps/`           | Deployable apps: `web`, `api`, `worker`, `realtime`, `control-api`, `fakes`                         |
| `packages/`       | Shared engines and libraries (`@sm/*`)                                                              |
| `packages/config` | Shared ESLint (with the `sm/logical-css` and `sm/design-tokens` rules), Prettier and tsconfig bases |
| `infra/terraform` | AWS infrastructure as code                                                                          |
| `docs/`           | Spec, ADRs, phase plans and handoffs, module docs, runbooks                                         |
