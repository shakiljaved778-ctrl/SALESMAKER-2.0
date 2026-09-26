-- 0005_hierarchy — P01 T03: org hierarchy (org_unit + closure), user placement and profile fields.
-- Additive (expand-only).
-- AlterTable
ALTER TABLE "user" ADD COLUMN     "deactivated_at" TIMESTAMPTZ(6),
ADD COLUMN     "department" TEXT,
ADD COLUMN     "manager_id" UUID,
ADD COLUMN     "org_unit_id" UUID,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "title" TEXT;

-- CreateTable
CREATE TABLE "org_unit" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "org_unit_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "org_unit_closure" (
    "tenant_id" UUID NOT NULL,
    "ancestor_id" UUID NOT NULL,
    "descendant_id" UUID NOT NULL,
    "depth" INTEGER NOT NULL,

    CONSTRAINT "org_unit_closure_pkey" PRIMARY KEY ("tenant_id","ancestor_id","descendant_id")
);

-- CreateIndex
CREATE INDEX "org_unit_tenant_id_parent_id_idx" ON "org_unit"("tenant_id", "parent_id");

-- CreateIndex
CREATE INDEX "org_unit_closure_tenant_id_descendant_id_depth_idx" ON "org_unit_closure"("tenant_id", "descendant_id", "depth");

-- CreateIndex
CREATE INDEX "user_tenant_id_org_unit_id_idx" ON "user"("tenant_id", "org_unit_id");

-- CreateIndex
CREATE INDEX "user_tenant_id_manager_id_idx" ON "user"("tenant_id", "manager_id");

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_tenant_id_org_unit_id_fkey" FOREIGN KEY ("tenant_id", "org_unit_id") REFERENCES "org_unit"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_tenant_id_manager_id_fkey" FOREIGN KEY ("tenant_id", "manager_id") REFERENCES "user"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_unit" ADD CONSTRAINT "org_unit_tenant_id_parent_id_fkey" FOREIGN KEY ("tenant_id", "parent_id") REFERENCES "org_unit"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_unit_closure" ADD CONSTRAINT "org_unit_closure_tenant_id_ancestor_id_fkey" FOREIGN KEY ("tenant_id", "ancestor_id") REFERENCES "org_unit"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_unit_closure" ADD CONSTRAINT "org_unit_closure_tenant_id_descendant_id_fkey" FOREIGN KEY ("tenant_id", "descendant_id") REFERENCES "org_unit"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Tree invariants ────────────────────────────────────────────────────────────────────────
ALTER TABLE "org_unit" ADD CONSTRAINT "org_unit_not_own_parent" CHECK ("parent_id" IS DISTINCT FROM "id");
ALTER TABLE "user" ADD CONSTRAINT "user_not_own_manager" CHECK ("manager_id" IS DISTINCT FROM "id");
ALTER TABLE "org_unit_closure" ADD CONSTRAINT "org_unit_closure_depth" CHECK ("depth" >= 0);

-- ── org_unit_closure maintenance ───────────────────────────────────────────────────────────
-- The closure holds every (ancestor, descendant) pair, including (unit, unit) at depth 0, and
-- changes in the same transaction as the tree. Only these triggers write it: they run as the
-- schema owner (SECURITY DEFINER), and sm_app may only read the table. RLS is forced, so the
-- owner still sees just the current tenant. Hierarchy changes take a per-tenant advisory lock,
-- so two concurrent moves cannot create a cycle between them.
CREATE OR REPLACE FUNCTION org_unit_closure_on_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('org_unit:' || NEW.tenant_id::text, 0));
  INSERT INTO org_unit_closure (tenant_id, ancestor_id, descendant_id, depth)
  SELECT NEW.tenant_id, NEW.id, NEW.id, 0
  UNION ALL
  SELECT NEW.tenant_id, c.ancestor_id, NEW.id, c.depth + 1
  FROM org_unit_closure c
  WHERE NEW.parent_id IS NOT NULL AND c.tenant_id = NEW.tenant_id AND c.descendant_id = NEW.parent_id;
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION org_unit_closure_on_move() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('org_unit:' || NEW.tenant_id::text, 0));
  -- A unit cannot move under itself or any of its descendants.
  IF NEW.parent_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM org_unit_closure
    WHERE tenant_id = NEW.tenant_id AND ancestor_id = NEW.id AND descendant_id = NEW.parent_id
  ) THEN
    RAISE EXCEPTION 'org unit % cannot move under its own subtree', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'org_unit_no_cycle';
  END IF;
  -- Detach the subtree from its old ancestors (paths from outside the subtree into it)...
  DELETE FROM org_unit_closure c
  USING org_unit_closure sub, org_unit_closure up
  WHERE sub.tenant_id = NEW.tenant_id AND sub.ancestor_id = NEW.id
    AND up.tenant_id = NEW.tenant_id AND up.descendant_id = NEW.id AND up.ancestor_id <> NEW.id
    AND c.tenant_id = NEW.tenant_id AND c.ancestor_id = up.ancestor_id
    AND c.descendant_id = sub.descendant_id;
  -- ...and attach it under the new parent's ancestors.
  INSERT INTO org_unit_closure (tenant_id, ancestor_id, descendant_id, depth)
  SELECT NEW.tenant_id, p.ancestor_id, sub.descendant_id, p.depth + sub.depth + 1
  FROM org_unit_closure p, org_unit_closure sub
  WHERE NEW.parent_id IS NOT NULL
    AND p.tenant_id = NEW.tenant_id AND p.descendant_id = NEW.parent_id
    AND sub.tenant_id = NEW.tenant_id AND sub.ancestor_id = NEW.id;
  RETURN NULL;
END
$$;

CREATE TRIGGER org_unit_closure_insert AFTER INSERT ON "org_unit"
  FOR EACH ROW EXECUTE FUNCTION org_unit_closure_on_insert();
CREATE TRIGGER org_unit_closure_move AFTER UPDATE OF "parent_id" ON "org_unit"
  FOR EACH ROW EXECUTE FUNCTION org_unit_closure_on_move();
REVOKE ALL ON FUNCTION org_unit_closure_on_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION org_unit_closure_on_move() FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON "org_unit_closure" FROM sm_app;

-- ── Manager chain ──────────────────────────────────────────────────────────────────────────
-- Reject a manager assignment that would make a user their own (indirect) manager. UNION (not
-- UNION ALL) keeps the walk finite even if a cycle ever existed.
CREATE OR REPLACE FUNCTION user_manager_no_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.manager_id IS NULL OR NEW.manager_id IS NOT DISTINCT FROM OLD.manager_id THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('user_manager:' || NEW.tenant_id::text, 0));
  IF EXISTS (
    WITH RECURSIVE chain(id) AS (
      SELECT NEW.manager_id
      UNION
      SELECT u.manager_id FROM "user" u JOIN chain ON u.id = chain.id
      WHERE u.tenant_id = NEW.tenant_id AND u.manager_id IS NOT NULL
    )
    SELECT 1 FROM chain WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'user % cannot report to their own report', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'user_manager_no_cycle';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER user_manager_no_cycle BEFORE INSERT OR UPDATE OF "manager_id" ON "user"
  FOR EACH ROW EXECUTE FUNCTION user_manager_no_cycle();

-- ── Row-level security ─────────────────────────────────────────────────────────────────────
SELECT enable_tenant_rls('org_unit');
SELECT enable_tenant_rls('org_unit_closure');
