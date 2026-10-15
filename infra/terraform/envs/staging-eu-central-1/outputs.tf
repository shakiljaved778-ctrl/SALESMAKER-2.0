output "cell" {
  value = {
    api_load_balancer     = module.cell.api_base_url_target
    db_endpoint           = module.cell.db_endpoint
    cache_endpoint        = module.cell.cache_endpoint
    files_bucket          = module.cell.files_bucket
    app_secret_arn        = module.cell.app_secret_arn
    migrate_secret_arn    = module.cell.migrate_secret_arn
    ecr_repositories      = module.cell.ecr_repositories
    ecs_cluster           = module.cell.ecs_cluster
    migrate_task          = module.cell.migrate_task
    storage_public_origin = module.cell.storage_public_origin
    inbound_email         = module.cell.inbound_email
  }
}

output "control_plane" {
  value = {
    load_balancer      = module.control_plane.endpoint_target
    db_endpoint        = module.control_plane.db_endpoint
    app_secret_arn     = module.control_plane.app_secret_arn
    migrate_secret_arn = module.control_plane.migrate_secret_arn
    ecr_repository     = module.control_plane.ecr_repository
    ecs_cluster        = module.control_plane.ecs_cluster
    migrate_task       = module.control_plane.migrate_task
  }
}
