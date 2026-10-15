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
    realtime = optional(string)
  })
}

variable "migrate_image" {
  description = "The migrate image (infra/docker/app/Dockerfile, target migrate), same tag as the services."
  type        = string
}

variable "enable_realtime" {
  description = "Run the realtime WebSocket service (needs apps/realtime and images.realtime)."
  type        = bool
  default     = false
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

variable "email_from" {
  description = "EMAIL_FROM: the sender of system email, e.g. \"SalesMaker <no-reply@salesmaker.app>\"."
  type        = string
}

variable "breached_password_api_url" {
  description = "BREACHED_PASSWORD_API_URL: a k-anonymity range API (free, no key)."
  type        = string
  default     = "https://api.pwnedpasswords.com"
}

variable "auth_jwt_kid" {
  description = "AUTH_JWT_KID: the id of the signing key in the app secret (changes on rotation)."
  type        = string
}

variable "cell_service_kid" {
  description = "CELL_SERVICE_KID: the id of this cell's service key, as registered in the control plane's CELLS."
  type        = string
}

variable "secrets_key_id" {
  description = "SECRETS_KEY_ID: the id of the current secrets-at-rest key (changes on rotation)."
  type        = string
}

variable "turnstile_site_key" {
  description = "Cloudflare Turnstile site key for web forms; null leaves CAPTCHA off. The secret key goes in the app secret (TURNSTILE_SECRET_KEY, listed in optional_api_secret_keys)."
  type        = string
  default     = null
}

variable "optional_api_secret_keys" {
  description = "Extra app-secret keys the api receives, when they are set: OIDC_GOOGLE_CLIENT_SECRET, OIDC_MICROSOFT_CLIENT_SECRET, TURNSTILE_SECRET_KEY, INBOUND_EMAIL_SECRET."
  type        = list(string)
  default     = []
  validation {
    condition = alltrue([for k in var.optional_api_secret_keys : contains([
      "OIDC_GOOGLE_CLIENT_SECRET", "OIDC_MICROSOFT_CLIENT_SECRET", "TURNSTILE_SECRET_KEY", "INBOUND_EMAIL_SECRET",
    ], k)])
    error_message = "Unknown optional api secret key."
  }
}

variable "api_public_url" {
  description = "The cell API's public https URL (cp_cell.api_base_url), e.g. https://api.eu-central-1.salesmaker.app."
  type        = string
}

variable "inbound_email_domain" {
  description = "INBOUND_EMAIL_DOMAIN: lead addresses are leads-{token}@this domain."
  type        = string
}

variable "inbound_email_enabled" {
  description = "Receive email-to-lead through SES (receipt rule → files bucket → SNS → the API). Needs a region with SES receiving and the domain's MX record."
  type        = bool
  default     = false
}
