# Email-to-lead through SES (§7.1), when var.inbound_email_enabled. SES stores each message
# under inbound-email/ in the files bucket and notifies the topic; the API verifies the SNS
# signature, confirms the subscription itself and queues the message for the worker.
# DNS stays outside Terraform: publish the verification TXT record (output) and an MX record for
# the domain pointing at inbound-smtp.<region>.amazonaws.com (runbooks/deploy.md).

resource "aws_sns_topic" "inbound" {
  count             = var.inbound_email_enabled ? 1 : 0
  name              = "${local.name}-inbound-email"
  kms_master_key_id = aws_kms_key.cell.arn
}

data "aws_iam_policy_document" "inbound_topic" {
  count = var.inbound_email_enabled ? 1 : 0
  statement {
    sid       = "SesPublishes"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.inbound[0].arn]
    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "inbound" {
  count  = var.inbound_email_enabled ? 1 : 0
  arn    = aws_sns_topic.inbound[0].arn
  policy = data.aws_iam_policy_document.inbound_topic[0].json
}

resource "aws_sns_topic_subscription" "inbound_api" {
  count                  = var.inbound_email_enabled ? 1 : 0
  topic_arn              = aws_sns_topic.inbound[0].arn
  protocol               = "https"
  endpoint               = "${trimsuffix(var.api_public_url, "/")}/v1/inbound/email"
  endpoint_auto_confirms = true
}

resource "aws_ses_domain_identity" "inbound" {
  count  = var.inbound_email_enabled ? 1 : 0
  domain = var.inbound_email_domain
}

resource "aws_ses_receipt_rule_set" "inbound" {
  count         = var.inbound_email_enabled ? 1 : 0
  rule_set_name = "${local.name}-inbound"
}

resource "aws_ses_receipt_rule" "leads" {
  count         = var.inbound_email_enabled ? 1 : 0
  name          = "leads"
  rule_set_name = aws_ses_receipt_rule_set.inbound[0].rule_set_name
  recipients    = [var.inbound_email_domain]
  enabled       = true
  scan_enabled  = true
  tls_policy    = "Require"

  s3_action {
    position          = 1
    bucket_name       = aws_s3_bucket.files.bucket
    object_key_prefix = "inbound-email/"
    topic_arn         = aws_sns_topic.inbound[0].arn
    # No kms_key_arn: that turns on SES client-side encryption, which the worker cannot read.
    # The bucket's default SSE-KMS (cell key) encrypts the stored message.
  }

  depends_on = [aws_s3_bucket_policy.files, aws_sns_topic_policy.inbound]
}

# A region has one active receipt rule set; this cell's account must not need another.
resource "aws_ses_active_receipt_rule_set" "inbound" {
  count         = var.inbound_email_enabled ? 1 : 0
  rule_set_name = aws_ses_receipt_rule_set.inbound[0].rule_set_name
}
