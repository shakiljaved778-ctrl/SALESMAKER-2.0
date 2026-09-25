variable "environment" {
  type = string
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
  description = "ACM certificate for the control-plane host (e.g. cp.salesmaker.app)."
  type        = string
}

variable "image" {
  description = "control-api image (ECR URI, immutable tag)."
  type        = string
}

variable "web_base_domain" {
  type = string
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "cache_node_type" {
  type    = string
  default = "cache.t4g.small"
}

variable "desired_count" {
  type    = number
  default = 2
}
