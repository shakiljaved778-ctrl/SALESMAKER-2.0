# Deploy

Status: **ready, not applied.** The images, the Terraform and the pipeline exist and are checked in CI.
Nothing has been provisioned: the first apply needs the owner decisions below.

| Piece                  | Where                                    | Checked by                                             |
| ---------------------- | ---------------------------------------- | ------------------------------------------------------ |
| Server images          | `infra/docker/app/Dockerfile`            | CI `images` (build + config fail-fast), locally booted |
| Infrastructure (AWS)   | `infra/terraform` (cells, control plane) | CI `terraform` (fmt, validate, tflint)                 |
| Pipeline               | `.github/workflows/deploy-staging.yml`   | manual (`workflow_dispatch`); a no-op until configured |
| ECS steps              | `infra/deploy/ecs.sh`                    | used by the pipeline (`migrate`, `roll`)               |
| Web (Vercel, ADR-0003) | `apps/web/vercel.json`, `deploy-web.yml` | local `vercel build`; production only via the workflow |

## Decisions the owner makes first (§0.3)

These cost money or send real messages, so they are not made in code:

1. **AWS account** for staging and who may assume the deploy role (GitHub OIDC). Staging runs RDS, Valkey, NAT,
   ALBs and Fargate: a standing monthly bill.
2. **Domains**: the web base domain (workspaces at `{slug}.{domain}`, a wildcard), the cell API host, the
   control-plane host, ACM certificates for both API hosts.
3. **SMTP provider** for `SMTP_URL`/`EMAIL_FROM` (signup verification, invitations, notifications). Real email.
4. **Vercel** project and plan, with the wildcard domain (wildcards need Vercel's nameservers).
5. Optional, each off until decided: **Cloudflare Turnstile** for web forms, **SES receiving** for email-to-lead
   (check that the region offers SES email receiving), **Google/Microsoft OIDC** apps.

## Images

One Dockerfile, one app per build; arm64 in ECS.

```bash
docker buildx build -f infra/docker/app/Dockerfile --target app --build-arg APP=api .         # api | worker | control-api
docker buildx build -f infra/docker/app/Dockerfile --target migrate .                          # migrations
```

- `app`: production dependencies only, runs as `node`, works with a read-only root filesystem (`/tmp` is the
  only writable path). `CMD node dist/main.js`. Startup validates the whole config and exits on any error.
- `migrate`: `sm-migrate cell | control-plane | bootstrap-cell`. Built on the full Node image (Prisma's schema
  engine needs libssl); the engine is fetched at build time.
- The web app is not containerised: Vercel builds it.

## Configuration

Names match the zod schemas in `apps/*/src/config.ts` and `apps/web/src/server/env.ts`. Terraform sets the plain
values; secrets come from Secrets Manager JSON documents written out of band (`rotate-keys.md`), never tfvars.
ECS refuses to start a task whose secret lacks a referenced key, so every listed key must exist.

### Cell (`sm-{env}-{cell}/app`, plus Terraform-set values)

| Variable                                                                    | api | worker | Source                                        |
| --------------------------------------------------------------------------- | :-: | :----: | --------------------------------------------- |
| `CELL_DATABASE_URL` (sm_app)                                                |  ✓  |   ✓    | secret                                        |
| `CELL_AUDIT_DATABASE_URL` (sm_audit)                                        |     |   ✓    | secret                                        |
| `REDIS_URL` (`rediss://:AUTH@…:6379`)                                       |  ✓  |   ✓    | secret                                        |
| `CELL_SERVICE_PRIVATE_KEY_PEM`                                              |  ✓  |   ✓    | secret                                        |
| `SMTP_URL`, `EMAIL_ROUTING_PEPPER`                                          |  ✓  |        | secret                                        |
| `AUTH_JWT_PRIVATE_KEY_PEM`, `AUTH_JWT_PREVIOUS_KEYS` (`[]` at first)        |  ✓  |        | secret                                        |
| `SECRETS_KEY`, `SECRETS_PREVIOUS_KEYS` (`{}` at first)                      |  ✓  |        | secret                                        |
| `TURNSTILE_SECRET_KEY`, `INBOUND_EMAIL_SECRET`, `OIDC_*_CLIENT_SECRET`      |  ✓  |        | secret, only if in `optional_api_secret_keys` |
| `CELL_ID`, `CELL_SERVICE_KID`, `CONTROL_API_BASE_URL`, `WEB_BASE_DOMAIN`    |  ✓  |   ✓    | Terraform                                     |
| `S3_BUCKET`, `S3_REGION` (credentials: the task role, no keys)              |  ✓  |   ✓    | Terraform                                     |
| `EMAIL_FROM`, `BREACHED_PASSWORD_API_URL`, `AUTH_JWT_KID`, `SECRETS_KEY_ID` |  ✓  |        | Terraform                                     |
| `INBOUND_EMAIL_DOMAIN`, `INBOUND_SES_TOPIC_ARN`, `TURNSTILE_SITE_KEY`       |  ✓  |        | Terraform (the last two when enabled)         |

Migrate task (`sm-{env}-{cell}/migrate`): `CELL_DATABASE_URL_MIGRATOR`, `CELL_ADMIN_DATABASE_URL` (RDS master,
from the RDS-managed secret), `SM_MIGRATOR_PASSWORD`, `SM_APP_PASSWORD`, `SM_REPORTS_PASSWORD`,
`SM_AUDIT_PASSWORD`. The role passwords must match the URLs in the app secret. `bootstrap-cell` refuses to run in
production without all four.

### Control plane (`sm-{env}-cp/app`, `sm-{env}-cp/migrate`)

`CP_DATABASE_URL`, `REDIS_URL`, `EMAIL_ROUTING_PEPPER` (same value as the cells), `SMTP_URL`, `CELLS` (JSON: each
cell's `id`, `region`, `label`, `apiBaseUrl` and service **public** key); Terraform sets `EMAIL_FROM`,
`WEB_BASE_DOMAIN`. The migrate secret holds `CP_DATABASE_URL`.

### Web (Vercel project, root directory `apps/web`)

| Variable                | Value                                                                  |
| ----------------------- | ---------------------------------------------------------------------- |
| `CONTROL_API_BASE_URL`  | the control plane's https URL                                          |
| `WEB_BASE_DOMAIN`       | e.g. `staging.salesmaker.app` (add the apex and `*.` wildcard domains) |
| `WEB_URL_SCHEME`        | `https`                                                                |
| `STORAGE_PUBLIC_ORIGIN` | Terraform output `cell.storage_public_origin` (CSP for direct uploads) |

## First deploy (staging)

1. **State**: create the state bucket (versioned, SSE-KMS) and lock table; `backend.hcl` from the example.
2. **Variables**: `terraform.tfvars` from the example (domains, certificates, key ids; no secrets).
3. **Registries first**: images do not exist yet, so apply the ECR repositories alone, then push one build:
   `terraform apply -target=module.cell.aws_ecr_repository.service -target=module.control_plane.aws_ecr_repository.control_api`,
   then run **deploy-staging** once (it builds and pushes; its deploy job fails harmlessly until step 4).
4. **Apply** everything with the pushed tags in `cell_images`, `migrate_image`, `control_api_image`; a second person
   reviews the plan. Leave `inbound_email_enabled` false.
5. **Secrets**: generate keys (`rotate-keys.md`) and write the four JSON documents (cell app and migrate, control
   plane app and migrate). Register the cell in the control plane's `CELLS`.
6. **Deploy** with _bootstrap_ ticked: the control plane migrates and rolls, the cell database gets its roles,
   then migrations, then api and worker. Point DNS at the load balancers (outputs).
7. **Web**: set up the Vercel project ("Web on Vercel" below) and run **deploy-web**. Smoke the e2e journeys
   against it (signup → verify → sign in → create a lead).
8. **Optional features**, each when decided: Turnstile (site key in tfvars, secret key in the app secret and in
   `optional_api_secret_keys`); SES (`inbound_email_enabled = true` **after** the API is healthy, since SNS
   confirms its subscription against it; then publish the TXT and MX records from the `inbound_email` output).

## Every deploy

Run **deploy-staging** on the commit (CI green first). It:

1. **Builds** arm64 images for api, worker, control-api and migrate, tagged with the commit (immutable).
2. **Migrates, expand only** (§11.3): control plane, then the cell, as one-off ECS tasks; a non-zero exit stops
   the deploy before any service changes. Migrations must be backwards compatible with the running code; a
   contraction ships in a later release, after nothing reads the old shape.
3. **Rolls** control-api, then api and worker: 100% healthy capacity kept, `/health/ready` checks, the circuit
   breaker rolls back failed tasks (and the step fails if it did).
4. **Smokes** both `/health/ready` endpoints.

When it succeeds, **deploy-web** ships the same commit to Vercel production: the web goes out last, after the
APIs it calls (it only relies on released contracts).

For production, watch error rates and p95 for 15 minutes after the roll.

## Web on Vercel

The web app is the only part on Vercel. It cannot serve without the APIs: every page asks the control plane which
workspace a host is, and the browser's calls go through the web's `/api` routes to the cell. Deploy the backend
first.

**Project (once).**

1. Vercel → Add New → Project → import `SALESMAKER-2.0`. **Root Directory `apps/web`**, with "Include files
   outside the root directory" on (workspace packages). Framework, install and build commands come from
   `apps/web/vercel.json`; Node 24 from `engines`.
2. Environment variables (Production): the four in "Web" above, plus `ENABLE_EXPERIMENTAL_COREPACK=1` so the
   build uses the repository's pnpm (`packageManager`).
3. Domains: the apex (`salesmaker.app`), `www.` and the wildcard `*.salesmaker.app` (workspaces at
   `{slug}.{domain}` and `forms.{domain}` for short web-form links; a wildcard needs the domain on Vercel's
   nameservers).
4. Settings → Functions → region **Frankfurt (fra1)**, next to the eu-central-1 cell (also set in `vercel.json`).
5. `vercel link` locally gives the team and project ids; add them to the GitHub `production` environment with a
   token: secret `VERCEL_TOKEN`, variables `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `WEB_URL`.

**Deploys.** `vercel.json` turns off Vercel's automatic production deploys from `main`, so the web can never
go out ahead of its APIs; **deploy-web** builds with the project's production settings, uploads the prebuilt
output and smokes `/api/health` and `/`. Pushes to other branches still get preview deployments, but a preview
URL (`*.vercel.app`) is neither the apex nor a workspace host, so previews only render when given their own
`WEB_BASE_DOMAIN` and a wildcard preview domain.

**Startup check.** `src/instrumentation.ts` validates the environment when a function instance starts; a
missing variable shows up as a `ZodError` naming it in the function logs.

**Rollback.** Vercel → Deployments → the previous production deployment → Promote (instant; no rebuild).

## Rollback

Roll the ECS services back to the previous task definition (`aws ecs update-service --task-definition <previous>`).
Because migrations only expand, the previous code works on the migrated schema. Never roll back a migration in
place; write a forward fix. Web: see "Web on Vercel".

## Checklist

- [ ] CI green on the commit (including rls-audit, OpenAPI drift, e2e, images and terraform)
- [ ] Migration reviewed for expand/contract and lock impact (large tables: `CONCURRENTLY`, batched backfills)
- [ ] New config keys added to Terraform and, for secrets, written to Secrets Manager **before** the deploy
- [ ] Release notes and any feature flags recorded
