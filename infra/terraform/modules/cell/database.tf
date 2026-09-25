# PostgreSQL 16, Multi-AZ, 35-day PITR (§11.3), encrypted with the cell key. The master password
# lives only in Secrets Manager (RDS-managed); roles sm_migrator / sm_app / sm_readonly_reports /
# sm_support are created by `db:bootstrap`, never by Terraform.

resource "aws_db_subnet_group" "cell" {
  name       = local.name
  subnet_ids = var.isolated_subnet_ids
}

resource "aws_db_parameter_group" "cell" {
  name   = "${local.name}-pg16"
  family = "postgres16"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements,pg_partman_bgw"
    apply_method = "pending-reboot"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "500"
  }
  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "60000"
  }
}

resource "aws_db_instance" "primary" {
  identifier     = local.name
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class

  allocated_storage     = var.db_allocated_storage_gb
  max_allocated_storage = var.db_allocated_storage_gb * 10
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.cell.arn

  db_name                       = "salesmaker"
  username                      = "sm_admin"
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.cell.arn

  multi_az               = true
  db_subnet_group_name   = aws_db_subnet_group.cell.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.cell.name
  publicly_accessible    = false

  backup_retention_period   = 35
  backup_window             = "02:00-03:00"
  maintenance_window        = "sun:03:30-sun:04:30"
  copy_tags_to_snapshot     = true
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name}-final"

  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.cell.arn
  performance_insights_retention_period = 7
  monitoring_interval                   = 0
  enabled_cloudwatch_logs_exports       = ["postgresql"]
  auto_minor_version_upgrade            = true
  iam_database_authentication_enabled   = true
}

resource "aws_db_instance" "reports" {
  count                  = var.db_read_replica ? 1 : 0
  identifier             = "${local.name}-reports"
  replicate_source_db    = aws_db_instance.primary.identifier
  instance_class         = var.db_instance_class
  storage_encrypted      = true
  kms_key_id             = aws_kms_key.cell.arn
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.cell.name
  publicly_accessible    = false
  skip_final_snapshot    = true

  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.cell.arn
  auto_minor_version_upgrade      = true
}
