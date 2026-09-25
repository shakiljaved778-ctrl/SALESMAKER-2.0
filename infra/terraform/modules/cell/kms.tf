# One customer-managed key per cell (§6.6): RDS, Valkey, S3, logs and secrets are encrypted with
# it, so a cell's data can be cut off or crypto-shredded on its own.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  name = "sm-${var.environment}-${var.cell_id}"
}

data "aws_iam_policy_document" "kms" {
  statement {
    sid       = "AccountAdministers"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }
  statement {
    sid       = "CloudWatchLogs"
    actions   = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["logs.${data.aws_region.current.region}.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:log-group:/sm/${var.environment}/${var.cell_id}/*"]
    }
  }
}

resource "aws_kms_key" "cell" {
  description             = "${local.name} data key"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.kms.json
}

resource "aws_kms_alias" "cell" {
  name          = "alias/${local.name}"
  target_key_id = aws_kms_key.cell.key_id
}
