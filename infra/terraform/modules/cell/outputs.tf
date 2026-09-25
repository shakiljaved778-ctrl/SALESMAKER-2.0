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

output "ecr_repositories" {
  value = { for k, r in aws_ecr_repository.service : k => r.repository_url }
}

output "ecs_cluster" {
  value = aws_ecs_cluster.cell.name
}
