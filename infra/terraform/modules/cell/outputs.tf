output "api_base_url_target" {
  description = "Point the cell's API host (the cp_cell.api_base_url) at this load balancer."
  value       = aws_lb.cell.dns_name
}

output "kms_key_arn" {
  value = aws_kms_key.cell.arn
}

output "db_endpoint" {
  value = aws_db_instance.primary.address
}

output "db_master_secret_arn" {
  description = "RDS-managed master credentials, for db:bootstrap only."
  value       = aws_db_instance.primary.master_user_secret[0].secret_arn
}

output "reports_endpoint" {
  value = var.db_read_replica ? aws_db_instance.reports[0].address : null
}

output "cache_endpoint" {
  value = aws_elasticache_replication_group.cell.primary_endpoint_address
}

output "files_bucket" {
  value = aws_s3_bucket.files.bucket
}

output "app_secret_arn" {
  value = aws_secretsmanager_secret.app.arn
}

output "migrate_secret_arn" {
  value = aws_secretsmanager_secret.migrate.arn
}

output "migrate_task" {
  description = "What the deploy pipeline needs to run the migrate task (aws ecs run-task)."
  value = {
    cluster            = aws_ecs_cluster.cell.name
    task_definition    = aws_ecs_task_definition.migrate.family
    subnets            = var.private_subnet_ids
    security_group_ids = [aws_security_group.app.id]
  }
}

output "storage_public_origin" {
  description = "STORAGE_PUBLIC_ORIGIN for the web app's CSP (connect-src)."
  value       = "https://${aws_s3_bucket.files.bucket_regional_domain_name}"
}

output "inbound_email" {
  description = "DNS to publish when inbound email is on: the SES verification TXT record and the MX target."
  value = var.inbound_email_enabled ? {
    domain           = var.inbound_email_domain
    verification_txt = "_amazonses.${var.inbound_email_domain} TXT ${aws_ses_domain_identity.inbound[0].verification_token}"
    mx               = "10 inbound-smtp.${data.aws_region.current.region}.amazonaws.com"
    sns_topic_arn    = aws_sns_topic.inbound[0].arn
  } : null
}

output "ecr_repositories" {
  value = { for k, r in aws_ecr_repository.service : k => r.repository_url }
}

output "ecs_cluster" {
  value = aws_ecs_cluster.cell.name
}
