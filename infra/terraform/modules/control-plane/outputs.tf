output "endpoint_target" {
  description = "Point the control-plane host (CONTROL_API_BASE_URL) at this load balancer."
  value       = aws_lb.cp.dns_name
}

output "db_endpoint" {
  value = aws_db_instance.cp.address
}

output "app_secret_arn" {
  value = aws_secretsmanager_secret.app.arn
}

output "ecr_repository" {
  value = aws_ecr_repository.control_api.repository_url
}
