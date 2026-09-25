# Terraform (AWS)

Infrastructure as code for SalesMaker's regional cells and the global control plane (§3.4, §11).
**Nothing here has been applied yet** (P00 delivers the skeleton; the first apply belongs to the
staging deploy work).

| Path                        | What                                                                                                                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modules/network`           | VPC with public (ALB, NAT), private (ECS tasks) and isolated (RDS, Valkey) subnets per AZ, S3 gateway endpoint, rejected-traffic flow logs                                                                                                               |
| `modules/cell`              | One regional cell: KMS key, RDS PostgreSQL 16 (Multi-AZ, 35-day PITR, optional reporting replica), ElastiCache Valkey 8 (TLS + AUTH), S3 files bucket, ECR, ECS Fargate services (api, worker, realtime) behind an HTTPS ALB, Secrets Manager containers |
| `modules/control-plane`     | The global control plane: its own Postgres, Valkey, control-api service and ALB. No CRM data                                                                                                                                                             |
| `envs/staging-eu-central-1` | Staging: the `eu-central-1` cell plus the control plane                                                                                                                                                                                                  |

## Conventions

- **Every cell is independent**: its own VPC, KMS key and data stores. No cross-cell networking or joins (§3.4).
- **No secrets in code, tfvars or outputs.** Terraform creates Secrets Manager containers; values are written out of
  band (`docs/runbooks/rotate-keys.md`). The RDS master password is RDS-managed. The Valkey AUTH token is generated
  and therefore lives in state: the state bucket is encrypted and access-restricted.
- **Database roles** (`sm_migrator`, `sm_app`, `sm_readonly_reports`, `sm_support`) are created by `db:bootstrap`, not
  by Terraform.
- **Images are immutable tags** set by the deploy pipeline; ECS services ignore task-definition drift so a deploy
  and a Terraform run never fight.

## Checks

CI runs `terraform fmt -check`, `terraform init -backend=false` + `terraform validate` on the staging environment
(which covers every module), and `tflint` with the AWS ruleset. Locally:

```bash
cd infra/terraform
terraform fmt -check -recursive
cd envs/staging-eu-central-1 && terraform init -backend=false && terraform validate
tflint --init && tflint --recursive --config "$PWD/../../.tflint.hcl"
```

## First apply (later)

1. Create the state bucket (versioned, SSE-KMS) and copy `backend.hcl.example` → `backend.hcl`.
2. Copy `terraform.tfvars.example` → `terraform.tfvars` and fill in certificates and image tags.
3. `terraform init -backend-config=backend.hcl && terraform plan`, reviewed by a second person.
4. Bootstrap the database roles and write the app secrets (runbooks), then deploy the images.
