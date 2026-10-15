variable "web_base_domain" {
  description = "Staging web domain, e.g. staging.salesmaker.app."
  type        = string
}

variable "control_api_base_url" {
  description = "https URL of the staging control plane."
  type        = string
}

variable "cell_certificate_arn" {
  type = string
}

variable "control_plane_certificate_arn" {
  type = string
}

variable "cell_images" {
  type = object({
    api      = string
    worker   = string
    realtime = optional(string)
  })
}

variable "migrate_image" {
  type = string
}

variable "cell_api_public_url" {
  description = "https URL of the staging cell API (the cp_cell.api_base_url)."
  type        = string
}

variable "email_from" {
  type = string
}

variable "auth_jwt_kid" {
  type = string
}

variable "cell_service_kid" {
  type = string
}

variable "secrets_key_id" {
  type = string
}

variable "inbound_email_enabled" {
  description = "Turn on after the API is healthy (SNS confirms the subscription against it)."
  type        = bool
  default     = false
}

variable "turnstile_site_key" {
  type    = string
  default = null
}

variable "optional_api_secret_keys" {
  type    = list(string)
  default = []
}

variable "control_api_image" {
  type = string
}
