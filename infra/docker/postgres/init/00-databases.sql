-- Local-only bootstrap. Creates the cell and control-plane databases and the extensions.
-- Roles and grants are created by migrations in packages/db (T04), not here.
CREATE DATABASE salesmaker_cell;
CREATE DATABASE salesmaker_cp;
CREATE DATABASE salesmaker_test;

\connect salesmaker_cell
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS partman;
-- pg_partman ships in infra/docker/postgres/Dockerfile. It is created only when the image
-- provides it, so a plain pgvector image still boots for tests that do not need partitions.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_partman') THEN
    CREATE EXTENSION IF NOT EXISTS pg_partman SCHEMA partman;
  END IF;
END $$;

\connect salesmaker_cp
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
