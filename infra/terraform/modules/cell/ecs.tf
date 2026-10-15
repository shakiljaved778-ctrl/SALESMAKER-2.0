# Fargate services in private subnets (§3.1): api (HTTP), worker (BullMQ), realtime (WS).
# Images are immutable tags pushed by deploy-staging.yml; deploys roll with a circuit breaker.

locals {
  # realtime arrives with apps/realtime; until then the cell runs api and worker only.
  all_services = {
    api      = { port = 4000, public = true, command = ["node", "dist/main.js"] }
    worker   = { port = null, public = false, command = ["node", "dist/main.js"] }
    realtime = { port = 4001, public = true, command = ["node", "dist/main.js"] }
  }
  services = { for k, v in local.all_services : k => v if k != "realtime" || var.enable_realtime }

  # Plain settings; every name matches the app's zod config (apps/*/src/config.ts).
  common_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "CELL_ID", value = var.cell_id },
    { name = "CELL_SERVICE_KID", value = var.cell_service_kid },
    { name = "CONTROL_API_BASE_URL", value = var.control_api_base_url },
    { name = "WEB_BASE_DOMAIN", value = var.web_base_domain },
    { name = "WEB_URL_SCHEME", value = "https" },
    { name = "LOG_LEVEL", value = "info" },
    # Credentials come from the task role (no S3 keys in a cell).
    { name = "S3_BUCKET", value = aws_s3_bucket.files.bucket },
    { name = "S3_REGION", value = data.aws_region.current.region },
  ]

  api_environment = concat(
    [
      { name = "EMAIL_FROM", value = var.email_from },
      { name = "BREACHED_PASSWORD_API_URL", value = var.breached_password_api_url },
      { name = "AUTH_JWT_KID", value = var.auth_jwt_kid },
      { name = "SECRETS_KEY_ID", value = var.secrets_key_id },
      { name = "INBOUND_EMAIL_DOMAIN", value = var.inbound_email_domain },
    ],
    var.turnstile_site_key == null ? [] : [{ name = "TURNSTILE_SITE_KEY", value = var.turnstile_site_key }],
    var.inbound_email_enabled ? [{ name = "INBOUND_SES_TOPIC_ARN", value = aws_sns_topic.inbound[0].arn }] : [],
  )

  service_environment = {
    api      = local.api_environment
    worker   = []
    realtime = []
  }

  # Keys of the app secret's JSON document each service receives (least privilege: only the
  # worker gets the audit role). ECS refuses to start a task whose secret lacks a referenced key,
  # so optional keys are listed per deployment in var.optional_api_secret_keys.
  service_secret_keys = {
    api = concat([
      "CELL_DATABASE_URL",
      "REDIS_URL",
      "SMTP_URL",
      "EMAIL_ROUTING_PEPPER",
      "AUTH_JWT_PRIVATE_KEY_PEM",
      "AUTH_JWT_PREVIOUS_KEYS",
      "CELL_SERVICE_PRIVATE_KEY_PEM",
      "SECRETS_KEY",
      "SECRETS_PREVIOUS_KEYS",
    ], var.optional_api_secret_keys)
    worker = [
      "CELL_DATABASE_URL",
      "CELL_AUDIT_DATABASE_URL",
      "REDIS_URL",
      "CELL_SERVICE_PRIVATE_KEY_PEM",
    ]
    realtime = ["REDIS_URL", "AUTH_JWT_PREVIOUS_KEYS"]
  }
}

resource "aws_ecr_repository" "service" {
  for_each             = merge(local.services, { migrate = null })
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
  for_each          = merge(local.services, { migrate = null })
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
    resources = [aws_secretsmanager_secret.app.arn, aws_secretsmanager_secret.migrate.arn]
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
      environment = concat(
        local.common_environment,
        local.service_environment[each.key],
        each.value.port == null ? [] : [{ name = "PORT", value = tostring(each.value.port) }],
      )
      secrets = [
        for key in local.service_secret_keys[each.key] :
        { name = key, valueFrom = "${aws_secretsmanager_secret.app.arn}:${key}::" }
      ]
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

# One-off database task run by the deploy pipeline before the services roll (runbooks/deploy.md):
# `sm-migrate cell`, or `sm-migrate bootstrap-cell` once on the first deploy. No load balancer,
# no task role: it only talks to the database.
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.name}-migrate"
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
      name                   = "migrate"
      image                  = var.migrate_image
      essential              = true
      command                = ["cell"]
      readonlyRootFilesystem = true
      user                   = "node"
      mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "HOME", value = "/tmp" },
      ]
      secrets = [
        for key in [
          "CELL_DATABASE_URL_MIGRATOR",
          "CELL_ADMIN_DATABASE_URL",
          "SM_MIGRATOR_PASSWORD",
          "SM_APP_PASSWORD",
          "SM_REPORTS_PASSWORD",
          "SM_AUDIT_PASSWORD",
        ] :
        { name = key, valueFrom = "${aws_secretsmanager_secret.migrate.arn}:${key}::" }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.service["migrate"].name
          awslogs-region        = data.aws_region.current.region
          awslogs-stream-prefix = "migrate"
        }
      }
    }
  ])
}
