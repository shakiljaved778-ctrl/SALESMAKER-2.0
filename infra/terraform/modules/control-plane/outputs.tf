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

output "migrate_secret_arn" {
  value = aws_secretsmanager_secret.migrate.arn
}

output "migrate_task" {
  value = {
    cluster            = aws_ecs_cluster.cp.name
    task_definition    = aws_ecs_task_definition.migrate.family
    subnets            = var.private_subnet_ids
    security_group_ids = [aws_security_group.app.id]
  }
}

output "ecs_cluster" {
  value = aws_ecs_cluster.cp.name
}
