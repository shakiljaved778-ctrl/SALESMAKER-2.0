# Global control plane (§3.4): tenant directory, login routing, signup reservations, later
# Stripe and entitlements. It holds no CRM data. Same building blocks as a cell, smaller.


data "aws_region" "current" {}

locals {
  name = "sm-${var.environment}-cp"
  port = 4100
}

resource "aws_kms_key" "cp" {
  description             = "${local.name} data key"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "cp" {
  name          = "alias/${local.name}"
  target_key_id = aws_kms_key.cp.key_id
}

# ── Network access ─────────────────────────────────────────────────────────────────────

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public HTTPS into the control plane"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "alb_to_app" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = local.port
  to_port                      = local.port
}

resource "aws_security_group" "app" {
  name        = "${local.name}-app"
  description = "control-api tasks"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "app_from_alb" {
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = local.port
  to_port                      = local.port
}

resource "aws_vpc_security_group_egress_rule" "app_https" {
  security_group_id = aws_security_group.app.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "app_to_data" {
  for_each                     = { db = 5432, cache = 6379 }
  security_group_id            = aws_security_group.app.id
  referenced_security_group_id = aws_security_group.data.id
  ip_protocol                  = "tcp"
  from_port                    = each.value
  to_port                      = each.value
}

resource "aws_security_group" "data" {
  name        = "${local.name}-data"
  description = "Control-plane Postgres and Valkey: control-api only"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "data_from_app" {
  for_each                     = { db = 5432, cache = 6379 }
  security_group_id            = aws_security_group.data.id
  referenced_security_group_id = aws_security_group.app.id
  ip_protocol                  = "tcp"
  from_port                    = each.value
  to_port                      = each.value
}

# ── Data ───────────────────────────────────────────────────────────────────────────────────

resource "aws_db_subnet_group" "cp" {
  name       = local.name
  subnet_ids = var.isolated_subnet_ids
}

resource "aws_db_instance" "cp" {
  identifier                    = local.name
  engine                        = "postgres"
  engine_version                = "16"
  instance_class                = var.db_instance_class
  allocated_storage             = 20
  max_allocated_storage         = 200
  storage_type                  = "gp3"
  storage_encrypted             = true
  kms_key_id                    = aws_kms_key.cp.arn
  db_name                       = "controlplane"
  username                      = "cp_admin"
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.cp.arn
  multi_az                      = true
  db_subnet_group_name          = aws_db_subnet_group.cp.name
  vpc_security_group_ids        = [aws_security_group.data.id]
  publicly_accessible           = false
  backup_retention_period       = 35
  copy_tags_to_snapshot         = true
  deletion_protection           = true
  skip_final_snapshot           = false
  final_snapshot_identifier     = "${local.name}-final"
  auto_minor_version_upgrade    = true
}

resource "random_password" "cache_auth" {
  length  = 64
  special = false
}

resource "aws_elasticache_subnet_group" "cp" {
  name       = local.name
  subnet_ids = var.isolated_subnet_ids
}

resource "aws_elasticache_replication_group" "cp" {
  replication_group_id       = local.name
  description                = "${local.name} rate limits"
  engine                     = "valkey"
  engine_version             = "8.0"
  node_type                  = var.cache_node_type
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true
  subnet_group_name          = aws_elasticache_subnet_group.cp.name
  security_group_ids         = [aws_security_group.data.id]
  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.cp.arn
  transit_encryption_enabled = true
  auth_token                 = random_password.cache_auth.result
}

# Values written out of band (runbooks/rotate-keys.md): CP_DATABASE_URL, REDIS_URL,
# EMAIL_ROUTING_PEPPER, SMTP_URL, CELLS (each cell's API URL and service-token public key).
resource "aws_secretsmanager_secret" "app" {
  name       = "${local.name}/app"
  kms_key_id = aws_kms_key.cp.arn
}

# ── Service ──────────────────────────────────────────────────────────────────────────────

resource "aws_ecr_repository" "control_api" {
  name                 = "salesmaker/control-api"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecs_cluster" "cp" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enhanced"
  }
}

resource "aws_cloudwatch_log_group" "control_api" {
  name              = "/sm/${var.environment}/cp/control-api"
  retention_in_days = 90
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.app.arn]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.cp.arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

resource "aws_ecs_task_definition" "control_api" {
  family                   = "${local.name}-control-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  volume {
    name = "tmp"
  }
  container_definitions = jsonencode([
    {
      name                   = "control-api"
      image                  = var.image
      essential              = true
      readonlyRootFilesystem = true
      user                   = "node"
      mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
      portMappings           = [{ containerPort = local.port, protocol = "tcp" }]
      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "PORT", value = tostring(local.port) },
        { name = "WEB_BASE_DOMAIN", value = var.web_base_domain },
        { name = "WEB_URL_SCHEME", value = "https" },
        { name = "LOG_LEVEL", value = "info" },
      ]
      secrets = [
        for key in ["CP_DATABASE_URL", "REDIS_URL", "EMAIL_ROUTING_PEPPER", "SMTP_URL", "CELLS"] :
        { name = key, valueFrom = "${aws_secretsmanager_secret.app.arn}:${key}::" }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.control_api.name
          awslogs-region        = data.aws_region.current.region
          awslogs-stream-prefix = "control-api"
        }
      }
    }
  ])
}

resource "aws_lb" "cp" {
  name                       = local.name
  load_balancer_type         = "application"
  subnets                    = var.public_subnet_ids
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  enable_deletion_protection = var.environment == "production"
}

resource "aws_lb_target_group" "control_api" {
  name        = "${local.name}-api"
  port        = local.port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id
  health_check {
    path    = "/health/ready"
    matcher = "200"
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.cp.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.control_api.arn
  }
}

resource "aws_ecs_service" "control_api" {
  name            = "control-api"
  cluster         = aws_ecs_cluster.cp.id
  task_definition = aws_ecs_task_definition.control_api.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.control_api.arn
    container_name   = "control-api"
    container_port   = local.port
  }
  lifecycle {
    ignore_changes = [task_definition]
  }
}
