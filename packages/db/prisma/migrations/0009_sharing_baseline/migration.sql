-- 0009_sharing_baseline — P01 T08: org-wide defaults and the owner-visibility closure (§6.3,
-- §6.4). Additive (expand-only).
-- CreateEnum
CREATE TYPE "sharing_model" AS ENUM ('PRIVATE', 'PUBLIC_READ', 'PUBLIC_READ_WRITE', 'CONTROLLED_BY_PARENT');

-- CreateTable
CREATE TABLE "org_wide_default" (
    "tenant_id" UUID NOT NULL,
    "object" TEXT NOT NULL,
    "sharing_model" "sharing_model" NOT NULL,
    "grant_hierarchy" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "org_wide_default_pkey" PRIMARY KEY ("tenant_id","object")
);

-- CreateTable
CREATE TABLE "user_visibility_closure" (
    "tenant_id" UUID NOT NULL,
    "viewer_user_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,

    CONSTRAINT "user_visibility_closure_pkey" PRIMARY KEY ("tenant_id","viewer_user_id","owner_id")
);

-- CreateIndex
CREATE INDEX "user_visibility_closure_tenant_id_owner_id_idx" ON "user_visibility_closure"("tenant_id", "owner_id");


-- ── Owner visibility closure ───────────────────────────────────────────────────────────────
-- Rebuilds the closure rows of the given viewers (or of every user when p_viewers is NULL) in the
-- current tenant: each viewer sees their own records, those of users in org units strictly below
-- theirs, those of their direct reports, and those owned by queues they belong to. It is the only
-- writer (schema owner; sm_app can only read) and is serialised per tenant, so concurrent
-- rebuilds never collide. Set-based: one statement for all viewers.
CREATE OR REPLACE FUNCTION rebuild_user_visibility(p_viewers uuid[] DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  t uuid := app_current_tenant_id();
  n integer;
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'rebuild_user_visibility needs a tenant transaction';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('visibility:' || t::text, 0));
  DELETE FROM user_visibility_closure
  WHERE tenant_id = t AND (p_viewers IS NULL OR viewer_user_id = ANY (p_viewers));
  INSERT INTO user_visibility_closure (tenant_id, viewer_user_id, owner_id)
  SELECT t, v.id, o.owner_id
  FROM "user" v
  CROSS JOIN LATERAL (
    SELECT v.id AS owner_id
    UNION
    SELECT u.id FROM org_unit_closure c
    JOIN "user" u ON u.tenant_id = t AND u.org_unit_id = c.descendant_id
    WHERE c.tenant_id = t AND c.ancestor_id = v.org_unit_id AND c.depth > 0
    UNION
    SELECT r.id FROM "user" r WHERE r.tenant_id = t AND r.manager_id = v.id
    UNION
    SELECT q FROM user_queue_ids(v.id) AS q
  ) o
  WHERE v.tenant_id = t AND (p_viewers IS NULL OR v.id = ANY (p_viewers));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
REVOKE ALL ON FUNCTION rebuild_user_visibility(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rebuild_user_visibility(uuid[]) TO sm_app;
REVOKE INSERT, UPDATE, DELETE ON "user_visibility_closure" FROM sm_app;

-- Users whose visibility depends on where a user sits: those in org units strictly above the
-- given units (they see the subtree), for incremental rebuilds after a move or a placement.
CREATE OR REPLACE FUNCTION users_above_org_units(p_units uuid[]) RETURNS SETOF uuid
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT u.id FROM org_unit_closure c
  JOIN "user" u ON u.tenant_id = c.tenant_id AND u.org_unit_id = c.ancestor_id
  WHERE c.tenant_id = app_current_tenant_id() AND c.descendant_id = ANY (p_units) AND c.depth > 0
$$;

-- ── perm_version: the OWD feeds effective access ──────────────────────────────────────────
CREATE TRIGGER bump_perm_version AFTER INSERT OR UPDATE OR DELETE ON "org_wide_default"
  FOR EACH STATEMENT EXECUTE FUNCTION bump_perm_version();

-- ── Row-level security ─────────────────────────────────────────────────────────────────────
SELECT enable_tenant_rls('org_wide_default');
SELECT enable_tenant_rls('user_visibility_closure');
