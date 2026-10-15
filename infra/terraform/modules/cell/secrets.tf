# Application secrets (§11.5). Terraform creates the containers; values are written out of band
# (runbooks/rotate-keys.md, runbooks/deploy.md) and never appear in code, tfvars or state.

# JSON document read by the api, worker and realtime tasks; each takes only its own keys
# (local.service_secret_keys in ecs.tf).
resource "aws_secretsmanager_secret" "app" {
  name        = "${local.name}/app"
  description = "Runtime secrets for the ${local.name} services (JSON)."
  kms_key_id  = aws_kms_key.cell.arn
}

# JSON document read only by the one-off migrate task: CELL_DATABASE_URL_MIGRATOR, and for the
# first deploy's bootstrap CELL_ADMIN_DATABASE_URL and SM_{MIGRATOR,APP,REPORTS,AUDIT}_PASSWORD.
resource "aws_secretsmanager_secret" "migrate" {
  name        = "${local.name}/migrate"
  description = "Database owner and bootstrap credentials for the ${local.name} migrate task (JSON)."
  kms_key_id  = aws_kms_key.cell.arn
}
