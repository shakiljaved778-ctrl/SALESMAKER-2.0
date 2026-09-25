# Valkey 8 (spec v1.2), Multi-AZ with automatic failover, TLS and AUTH, encrypted at rest.
# Caches metadata and permission versions only; record data is never cached (§3.5).

resource "random_password" "cache_auth" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "cache_auth" {
  name       = "${local.name}/valkey-auth"
  kms_key_id = aws_kms_key.cell.arn
}

resource "aws_secretsmanager_secret_version" "cache_auth" {
  secret_id     = aws_secretsmanager_secret.cache_auth.id
  secret_string = random_password.cache_auth.result
}

resource "aws_elasticache_subnet_group" "cell" {
  name       = local.name
  subnet_ids = var.isolated_subnet_ids
}

resource "aws_elasticache_replication_group" "cell" {
  replication_group_id = local.name
  description          = "${local.name} cache, rate limits and queues"
  engine               = "valkey"
  engine_version       = "8.0"
  node_type            = var.cache_node_type
  num_cache_clusters   = 2
  port                 = 6379

  automatic_failover_enabled = true
  multi_az_enabled           = true
  subnet_group_name          = aws_elasticache_subnet_group.cell.name
  security_group_ids         = [aws_security_group.cache.id]

  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.cell.arn
  transit_encryption_enabled = true
  auth_token                 = random_password.cache_auth.result

  snapshot_retention_limit   = 7
  snapshot_window            = "01:00-02:00"
  maintenance_window         = "sun:04:30-sun:05:30"
  auto_minor_version_upgrade = true
}
