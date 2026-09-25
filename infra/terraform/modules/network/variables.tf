variable "name" {
  description = "Prefix for every resource, e.g. sm-staging-eu-central-1."
  type        = string
}

variable "cidr_block" {
  description = "VPC CIDR. Each cell and the control plane get non-overlapping ranges."
  type        = string
  validation {
    condition     = can(cidrnetmask(var.cidr_block))
    error_message = "cidr_block must be a valid IPv4 CIDR."
  }
}

variable "az_count" {
  description = "Availability zones to span (Multi-AZ RDS and Valkey need at least two)."
  type        = number
  default     = 3
  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3."
  }
}

variable "single_nat_gateway" {
  description = "One NAT gateway instead of one per AZ (cheaper; acceptable for staging only)."
  type        = bool
  default     = false
}
