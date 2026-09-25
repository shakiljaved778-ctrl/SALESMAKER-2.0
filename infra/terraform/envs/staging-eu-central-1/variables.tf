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
    realtime = string
  })
}

variable "control_api_image" {
  type = string
}
