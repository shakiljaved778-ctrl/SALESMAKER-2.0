# Application secrets (§11.5). Terraform creates the containers; values are written out of band
# (runbooks/rotate-keys.md) and never appear in code, tfvars or state.

locals {
  # Keys of the JSON document in the app secret, injected into the api and worker tasks.
  app_secret_keys = [
    "CELL_DATABASE_URL",
    "REDIS_URL",
    "SMTP_URL",
    "EMAIL_ROUTING_PEPPER",
    "AUTH_JWT_PRIVATE_KEY_PEM",
    "AUTH_JWT_PREVIOUS_KEYS",
    "CELL_SERVICE_PRIVATE_KEY_PEM",
    "SECRETS_KEY",
    "SECRETS_PREVIOUS_KEYS",
    "OIDC_GOOGLE_CLIENT_SECRET",
    "OIDC_MICROSOFT_CLIENT_SECRET",
  ]
}

resource "aws_secretsmanager_secret" "app" {
  name        = "${local.name}/app"
  description = "Runtime secrets for the ${local.name} api and worker (JSON)."
  kms_key_id  = aws_kms_key.cell.arn
}
