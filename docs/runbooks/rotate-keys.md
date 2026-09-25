# Rotate keys and secrets

Status: **stub**. Secrets live in AWS Secrets Manager (`sm-<env>-<cell>/app`, `sm-<env>-cp/app`), encrypted with the
cell's KMS key; they are never in code, tfvars or CI variables (§11.5).

## Session signing key (`AUTH_JWT_PRIVATE_KEY_PEM`)

1. Generate a new Ed25519 key pair and a new key id.
2. Move the current key to `AUTH_JWT_PREVIOUS_KEYS` (kid → public key) and set the new key and `AUTH_JWT_KID`.
3. Roll the api service. Tokens signed with the old key stay valid until they expire (15 minutes).
4. After the access-token lifetime has passed, remove the old key from `AUTH_JWT_PREVIOUS_KEYS`.

## Secrets-at-rest key ring (`SECRETS_KEY`, `SECRETS_KEY_ID`)

1. Add a new 32-byte key with a new id; move the current one into `SECRETS_PREVIOUS_KEYS`.
2. Roll the services: new writes use the new key; values encrypted with older keys still decrypt (the key id prefixes
   every ciphertext).
3. Re-encrypt old values with a background job (P01 adds it), then retire the old key.

## Cell service token key (`CELL_SERVICE_PRIVATE_KEY_PEM`)

The control plane verifies a cell's calls with the public key registered for that cell (`CELLS` / `cp_cell`).

1. Generate a new pair; register the new public key with the control plane alongside the old one.
2. Switch the cell to the new private key and `CELL_SERVICE_KID`; roll the cell.
3. Remove the old public key from the control plane.

## Also rotate on a schedule

Valkey AUTH token (re-apply Terraform, then update `REDIS_URL`), SMTP credentials, OIDC client secrets, and the email
HMAC pepper (**not** routinely: changing it orphans every stored email HMAC; only with a planned re-hash).
