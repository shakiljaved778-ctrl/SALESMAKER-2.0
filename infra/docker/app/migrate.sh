#!/bin/sh
# One-off database task for a deploy (docs/runbooks/deploy.md). Runs as an ECS task.
#   sm-migrate cell            Cell migrations as sm_migrator (CELL_DATABASE_URL_MIGRATOR)
#   sm-migrate control-plane   Control-plane migrations (CP_DATABASE_URL)
#   sm-migrate bootstrap-cell  First deploy only: roles and extensions (CELL_ADMIN_DATABASE_URL,
#                              SM_*_PASSWORD; refused in production without all four passwords)
set -eu
case "${1:-}" in
  cell)
    test -n "${CELL_DATABASE_URL_MIGRATOR:-}" || { echo "CELL_DATABASE_URL_MIGRATOR is required" >&2; exit 1; }
    cd /repo/packages/db && exec pnpm exec prisma migrate deploy
    ;;
  control-plane)
    test -n "${CP_DATABASE_URL:-}" || { echo "CP_DATABASE_URL is required" >&2; exit 1; }
    cd /repo/apps/control-api && exec pnpm exec prisma migrate deploy
    ;;
  bootstrap-cell)
    cd /repo/packages/db && exec node scripts/bootstrap.js
    ;;
  *)
    echo "usage: sm-migrate cell|control-plane|bootstrap-cell" >&2
    exit 64
    ;;
esac
