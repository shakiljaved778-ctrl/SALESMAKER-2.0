# ADR-0032: Temporary demo hosting (Vercel + Neon + a self-hosted backend)

- **Status:** Accepted (owner decision in the deployment session, 2026-10-23); temporary
- **Date:** 2026-10-23
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §3.1, §3.4, ADR-0003

## Context

ADR-0003 hosts the web on Vercel and the APIs and data on AWS. Before the AWS account, domains and costs are
settled, the owner wants the app online now: no custom domain, Neon's free Postgres, and the server programs on
the owner's own computer.

## Decision

A demo setup that sits beside ADR-0003 and does not replace it (`infra/demo/`, `docs/runbooks/demo-hosting.md`):

- **Web**: the existing Vercel project. `WEB_BASE_DOMAIN` is its `*.vercel.app` address (the apex).
- **Data**: Neon free tier, two databases (cell and control plane). Same roles, RLS and migrations as a cell; the
  bootstrap now also works for a non-superuser database owner.
- **Server programs**: api, worker, control-api, Valkey and Mailpit in Docker on the owner's computer, published
  through one ngrok static domain behind a Caddy gateway (`/cp/*` → control plane, the rest → cell API).
- **Workspaces**: `*.vercel.app` has no wildcard, so each demo workspace gets its own `vercel.app` alias through
  the control plane's existing custom-domain table (`cp_tenant_domain`). No change to tenant routing.

## Consequences

- Demo only: online while the owner's computer runs; seeded demo data; email lands in the local Mailpit; no
  object storage (imports are unavailable); no backups beyond Neon's.
- Signing up a new workspace and "find my workspace" links point at `{slug}.{WEB_BASE_DOMAIN}`, which does not
  resolve on `vercel.app`; they work once a custom domain exists.
- Moving to ADR-0003 needs no code change: the same images, migrations and settings deploy to AWS.
