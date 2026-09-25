# Staging (spec v1.2: mirrors production on ECS): one cell in eu-central-1 and the control plane.
# Nothing here has been applied; see ../../README.md before the first apply.

terraform {
  required_version = ">= 1.9.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.66"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
    }
  }
  # Partial configuration: bucket, key, region and lock table come from backend.hcl at init.
  backend "s3" {}
}

provider "aws" {
  region = "eu-central-1"
  default_tags {
    tags = {
      Project     = "salesmaker"
      Environment = "staging"
      ManagedBy   = "terraform"
    }
  }
}

module "cell_network" {
  source             = "../../modules/network"
  name               = "sm-staging-eu-central-1"
  cidr_block         = "10.20.0.0/16"
  single_nat_gateway = true
}

module "cell" {
  source               = "../../modules/cell"
  cell_id              = "eu-central-1"
  environment          = "staging"
  vpc_id               = module.cell_network.vpc_id
  public_subnet_ids    = module.cell_network.public_subnet_ids
  private_subnet_ids   = module.cell_network.private_subnet_ids
  isolated_subnet_ids  = module.cell_network.isolated_subnet_ids
  certificate_arn      = var.cell_certificate_arn
  images               = var.cell_images
  control_api_base_url = var.control_api_base_url
  web_base_domain      = var.web_base_domain

  # Staging sizing; production keeps the module defaults.
  db_instance_class = "db.t4g.medium"
  db_read_replica   = false
  cache_node_type   = "cache.t4g.small"
  service_sizes = {
    api      = { cpu = 512, memory = 1024, desired = 1 }
    worker   = { cpu = 512, memory = 1024, desired = 1 }
    realtime = { cpu = 256, memory = 512, desired = 1 }
  }
}

module "control_plane_network" {
  source             = "../../modules/network"
  name               = "sm-staging-cp"
  cidr_block         = "10.10.0.0/16"
  az_count           = 2
  single_nat_gateway = true
}

module "control_plane" {
  source              = "../../modules/control-plane"
  environment         = "staging"
  vpc_id              = module.control_plane_network.vpc_id
  public_subnet_ids   = module.control_plane_network.public_subnet_ids
  private_subnet_ids  = module.control_plane_network.private_subnet_ids
  isolated_subnet_ids = module.control_plane_network.isolated_subnet_ids
  certificate_arn     = var.control_plane_certificate_arn
  image               = var.control_api_image
  web_base_domain     = var.web_base_domain
  desired_count       = 1
}
