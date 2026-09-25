# Fargate services in private subnets (§3.1): api (HTTP), worker (BullMQ), realtime (WS).
# Images are immutable tags pushed by deploy-staging.yml; deploys roll with a circuit breaker.

locals {
  services = {
    api      = { port = 4000, public = true, command = ["node", "dist/main.js"] }
    worker   = { port = null, public = false, command = ["node", "dist/main.js"] }
    realtime = { port = 4001, public = true, command = ["node", "dist/main.js"] }
  }

  common_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "CELL_ID", value = var.cell_id },
    { name = "CONTROL_API_BASE_URL", value = var.control_api_base_url },
    { name = "WEB_BASE_DOMAIN", value = var.web_base_domain },
    { name = "WEB_URL_SCHEME", value = "https" },
    { name = "LOG_LEVEL", value = "info" },
    { name = "FILES_BUCKET", value = aws_s3_bucket.files.bucket },
    { name = "AWS_KMS_KEY_ID", value = aws_kms_key.cell.arn },
  ]

  app_secrets = [
    for key in local.app_secret_keys : { name = key, valueFrom = "${aws_secretsmanager_secret.app.arn}:${key}::" }
  ]
}

resource "aws_ecr_repository" "service" {
  for_each             = local.services
  name                 = "salesmaker/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.cell.arn
  }
}

resource "aws_ecs_cluster" "cell" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enhanced"
  }
}

resource "aws_cloudwatch_log_group" "service" {
  for_each          = local.services
  name              = "/sm/${var.environment}/${var.cell_id}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.cell.arn
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

# Execution role: pull images, write logs, read the secrets the task definition references.
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
    resources = [aws_kms_key.cell.arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# Task role: what the application itself may do (least privilege, §14.1).
resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

data "aws_iam_policy_document" "task" {
  statement {
    sid       = "Files"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"]
    resources = ["${aws_s3_bucket.files.arn}/*"]
  }
  statement {
    sid       = "FilesList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.files.arn]
  }
  statement {
    sid       = "CellKey"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.cell.arn]
  }
}

resource "aws_iam_role_policy" "task" {
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

resource "aws_ecs_task_definition" "service" {
  for_each                 = local.services
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.service_sizes[each.key].cpu
  memory                   = var.service_sizes[each.key].memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  # The root filesystem is read-only; /tmp is the only writable path.
  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([
    {
      name                   = each.key
      image                  = var.images[each.key]
      essential              = true
      command                = each.value.command
      readonlyRootFilesystem = true
      user                   = "node"
      mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
      portMappings           = each.value.port == null ? [] : [{ containerPort = each.value.port, protocol = "tcp" }]
      environment            = concat(local.common_environment, each.value.port == null ? [] : [{ name = "PORT", value = tostring(each.value.port) }])
      secrets                = local.app_secrets
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.service[each.key].name
          awslogs-region        = data.aws_region.current.region
          awslogs-stream-prefix = each.key
        }
      }
    }
  ])
}

resource "aws_ecs_service" "service" {
  for_each        = local.services
  name            = each.key
  cluster         = aws_ecs_cluster.cell.id
  task_definition = aws_ecs_task_definition.service[each.key].arn
  desired_count   = var.service_sizes[each.key].desired
  launch_type     = "FARGATE"

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  dynamic "load_balancer" {
    for_each = each.value.public ? [each.value.port] : []
    content {
      target_group_arn = aws_lb_target_group.service[each.key].arn
      container_name   = each.key
      container_port   = load_balancer.value
    }
  }

  # The deploy pipeline changes the image; Terraform owns everything else.
  lifecycle {
    ignore_changes = [task_definition]
  }
}
