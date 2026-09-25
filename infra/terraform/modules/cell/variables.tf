variable "cell_id" {
  description = "Cell identifier, e.g. eu-central-1. Matches CELL_ID and the control plane's cp_cell.id."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9-]{3,32}$", var.cell_id))
    error_message = "cell_id must be 3-32 lowercase letters, digits or hyphens."
  }
}

variable "environment" {
  description = "staging or production."
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "isolated_subnet_ids" {
  type = list(string)
}

variable "certificate_arn" {
  description = "ACM certificate for the cell API host (e.g. api.eu-central-1.salesmaker.app)."
  type        = string
}

variable "db_instance_class" {
  type    = string
  default = "db.r7g.large"
}

variable "db_allocated_storage_gb" {
  type    = number
  default = 100
}

variable "db_read_replica" {
  description = "Reporting replica for sm_readonly_reports (§3.4)."
  type        = bool
  default     = true
}

variable "cache_node_type" {
  type    = string
  default = "cache.r7g.large"
}

variable "images" {
  description = "Container image per service (ECR URI with an immutable tag, set by the deploy pipeline)."
  type = object({
    api      = string
    worker   = string
    realtime = string
  })
}

variable "service_sizes" {
  description = "Fargate CPU (units), memory (MiB) and desired count per service."
  type = map(object({
    cpu     = number
    memory  = number
    desired = number
  }))
  default = {
    api      = { cpu = 1024, memory = 2048, desired = 2 }
    worker   = { cpu = 1024, memory = 2048, desired = 2 }
    realtime = { cpu = 512, memory = 1024, desired = 2 }
  }
}

variable "control_api_base_url" {
  description = "The control plane's URL (CONTROL_API_BASE_URL)."
  type        = string
}

variable "web_base_domain" {
  description = "WEB_BASE_DOMAIN, e.g. salesmaker.app."
  type        = string
}

variable "log_retention_days" {
  type    = number
  default = 90
}
