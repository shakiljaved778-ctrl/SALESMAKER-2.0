-- 0001_init — control-plane schema. Requires the citext extension (created by infra bootstrap).
CREATE EXTENSION IF NOT EXISTS citext;

-- CreateEnum
CREATE TYPE "cp_tenant_status" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED');

-- CreateTable
CREATE TABLE "cp_cell" (
    "id" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "api_base_url" TEXT NOT NULL,
    "public_key_pem" TEXT NOT NULL,
    "signup_open" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cp_cell_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cp_tenant" (
    "id" UUID NOT NULL,
    "slug" CITEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cell_id" TEXT NOT NULL,
    "status" "cp_tenant_status" NOT NULL DEFAULT 'PENDING',
    "owner_email_hmac" BYTEA,
    "reserved_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_at" TIMESTAMPTZ(6),

    CONSTRAINT "cp_tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cp_tenant_domain" (
    "host" CITEXT NOT NULL,
    "tenant_id" UUID NOT NULL,

    CONSTRAINT "cp_tenant_domain_pkey" PRIMARY KEY ("host")
);

-- CreateTable
CREATE TABLE "cp_user_routing" (
    "email_hmac" BYTEA NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cp_user_routing_pkey" PRIMARY KEY ("email_hmac","tenant_id")
);

-- CreateTable
CREATE TABLE "cp_idempotency_key" (
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" BYTEA NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cp_idempotency_key_pkey" PRIMARY KEY ("scope","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "cp_tenant_slug_key" ON "cp_tenant"("slug");

-- CreateIndex
CREATE INDEX "cp_tenant_cell_id_idx" ON "cp_tenant"("cell_id");

-- CreateIndex
CREATE INDEX "cp_tenant_domain_tenant_id_idx" ON "cp_tenant_domain"("tenant_id");

-- CreateIndex
CREATE INDEX "cp_user_routing_tenant_id_idx" ON "cp_user_routing"("tenant_id");

-- CreateIndex
CREATE INDEX "cp_idempotency_key_expires_at_idx" ON "cp_idempotency_key"("expires_at");

-- AddForeignKey
ALTER TABLE "cp_tenant" ADD CONSTRAINT "cp_tenant_cell_id_fkey" FOREIGN KEY ("cell_id") REFERENCES "cp_cell"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cp_tenant_domain" ADD CONSTRAINT "cp_tenant_domain_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "cp_tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cp_user_routing" ADD CONSTRAINT "cp_user_routing_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "cp_tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

