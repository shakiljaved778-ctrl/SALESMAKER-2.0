# Add a regional cell

Status: **stub**. The second cell (me-central-1) is planned for P12 (§3.4, ADR-0005).

1. **Infrastructure.** Add `infra/terraform/envs/<env>-<region>/` using `modules/network` (a CIDR that overlaps no
   other cell) and `modules/cell` with the new `cell_id`. Review the plan with a second person, then apply.
2. **Database.** Run `db:bootstrap` with the RDS master secret, then `db:migrate` as `sm_migrator`. Store the `sm_app`
   and reporting connection strings in the cell's app secret.
3. **Secrets.** Generate the cell's session signing key, secrets key ring and service-token key pair
   (see rotate-keys.md) and write them to the cell's app secret.
4. **Register with the control plane.** Add the cell (id, region, label, API base URL, service-token public key) with
   `signup_open = false`.
5. **Deploy** the services (deploy.md) and verify `/health/ready`, a service-token call to the control plane, and an
   end-to-end signup with a test workspace.
6. **Open for signups** by setting `signup_open = true`. Existing tenants never move between cells (§3.4): there are
   no cross-cell joins, and residency is fixed at signup.
