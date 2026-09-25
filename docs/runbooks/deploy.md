# Deploy

Status: **stub** (the `deploy-staging.yml` pipeline arrives with the first staging apply).

## Order

1. **Build** images for api, worker, realtime and control-api, tagged with the git SHA; push to ECR (immutable tags).
2. **Migrate first, expand only.** Run `pnpm --filter @sm/db db:migrate` as `sm_migrator` in a one-off ECS task
   against each cell. Migrations must be backwards compatible with the running code (expand/contract, §11.3): a
   contraction ships in a later release, after nothing reads the old shape. The control plane migrates the same way.
3. **Roll the services.** Update each ECS service to the new task definition. Rolling deploys keep 100% healthy
   capacity and the circuit breaker rolls back on failed health checks (`/health/ready`).
4. **Web.** Deploy `apps/web` to Vercel after the APIs are healthy (it only relies on released contracts).
5. **Smoke.** Run the e2e smoke journeys against staging; for production, watch error rates and p95 for 15 minutes.

## Rollback

Roll the ECS services back to the previous task definition. Because migrations only expand, the previous code works
on the migrated schema. Never roll back a migration in place; write a forward fix.

## Checklist

- [ ] CI green on the commit (including rls-audit, OpenAPI drift and e2e)
- [ ] Migration reviewed for expand/contract and lock impact (large tables: `CONCURRENTLY`, batched backfills)
- [ ] Release notes and any feature flags recorded
