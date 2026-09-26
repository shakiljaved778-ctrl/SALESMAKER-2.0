-- 0007_groups_queues — P01 T06: public groups, queues and their members, with transitive
-- membership expansion (§6.3, §6.4). Additive (expand-only).
-- CreateEnum
CREATE TYPE "member_type" AS ENUM ('USER', 'GROUP', 'ORG_UNIT', 'ORG_UNIT_AND_SUBORDINATES');

-- CreateTable
CREATE TABLE "public_group" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "public_group_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "group_member" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "group_id" UUID NOT NULL,
    "member_type" "member_type" NOT NULL,
    "user_id" UUID,
    "member_group_id" UUID,
    "org_unit_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "group_member_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "queue" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "name" TEXT NOT NULL,
    "email" CITEXT,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "queue_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "queue_member" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "queue_id" UUID NOT NULL,
    "member_type" "member_type" NOT NULL,
    "user_id" UUID,
    "member_group_id" UUID,
    "org_unit_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "queue_member_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "queue_object" (
    "tenant_id" UUID NOT NULL,
    "queue_id" UUID NOT NULL,
    "object" TEXT NOT NULL,

    CONSTRAINT "queue_object_pkey" PRIMARY KEY ("tenant_id","queue_id","object")
);

-- CreateIndex
CREATE UNIQUE INDEX "public_group_tenant_id_name_key" ON "public_group"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "group_member_tenant_id_user_id_idx" ON "group_member"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "group_member_tenant_id_member_group_id_idx" ON "group_member"("tenant_id", "member_group_id");

-- CreateIndex
CREATE INDEX "group_member_tenant_id_org_unit_id_idx" ON "group_member"("tenant_id", "org_unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_member_tenant_id_group_id_user_id_key" ON "group_member"("tenant_id", "group_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_member_tenant_id_group_id_member_group_id_key" ON "group_member"("tenant_id", "group_id", "member_group_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_member_tenant_id_group_id_member_type_org_unit_id_key" ON "group_member"("tenant_id", "group_id", "member_type", "org_unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "queue_tenant_id_name_key" ON "queue"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "queue_member_tenant_id_user_id_idx" ON "queue_member"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "queue_member_tenant_id_member_group_id_idx" ON "queue_member"("tenant_id", "member_group_id");

-- CreateIndex
CREATE INDEX "queue_member_tenant_id_org_unit_id_idx" ON "queue_member"("tenant_id", "org_unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "queue_member_tenant_id_queue_id_user_id_key" ON "queue_member"("tenant_id", "queue_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "queue_member_tenant_id_queue_id_member_group_id_key" ON "queue_member"("tenant_id", "queue_id", "member_group_id");

-- CreateIndex
CREATE UNIQUE INDEX "queue_member_tenant_id_queue_id_member_type_org_unit_id_key" ON "queue_member"("tenant_id", "queue_id", "member_type", "org_unit_id");

-- CreateIndex
CREATE INDEX "queue_object_tenant_id_object_idx" ON "queue_object"("tenant_id", "object");

-- AddForeignKey
ALTER TABLE "group_member" ADD CONSTRAINT "group_member_tenant_id_group_id_fkey" FOREIGN KEY ("tenant_id", "group_id") REFERENCES "public_group"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_member" ADD CONSTRAINT "group_member_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "user"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_member" ADD CONSTRAINT "group_member_tenant_id_member_group_id_fkey" FOREIGN KEY ("tenant_id", "member_group_id") REFERENCES "public_group"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_member" ADD CONSTRAINT "group_member_tenant_id_org_unit_id_fkey" FOREIGN KEY ("tenant_id", "org_unit_id") REFERENCES "org_unit"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_member" ADD CONSTRAINT "queue_member_tenant_id_queue_id_fkey" FOREIGN KEY ("tenant_id", "queue_id") REFERENCES "queue"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_member" ADD CONSTRAINT "queue_member_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "user"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_member" ADD CONSTRAINT "queue_member_tenant_id_member_group_id_fkey" FOREIGN KEY ("tenant_id", "member_group_id") REFERENCES "public_group"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_member" ADD CONSTRAINT "queue_member_tenant_id_org_unit_id_fkey" FOREIGN KEY ("tenant_id", "org_unit_id") REFERENCES "org_unit"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "queue_object" ADD CONSTRAINT "queue_object_tenant_id_queue_id_fkey" FOREIGN KEY ("tenant_id", "queue_id") REFERENCES "queue"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Member rows name exactly the target their type calls for ───────────────────────────────
ALTER TABLE "group_member" ADD CONSTRAINT "group_member_target" CHECK (
  CASE "member_type"
    WHEN 'USER' THEN num_nonnulls("user_id") = 1 AND num_nonnulls("member_group_id", "org_unit_id") = 0
    WHEN 'GROUP' THEN num_nonnulls("member_group_id") = 1 AND num_nonnulls("user_id", "org_unit_id") = 0
    ELSE num_nonnulls("org_unit_id") = 1 AND num_nonnulls("user_id", "member_group_id") = 0
  END
);
ALTER TABLE "queue_member" ADD CONSTRAINT "queue_member_target" CHECK (
  CASE "member_type"
    WHEN 'USER' THEN num_nonnulls("user_id") = 1 AND num_nonnulls("member_group_id", "org_unit_id") = 0
    WHEN 'GROUP' THEN num_nonnulls("member_group_id") = 1 AND num_nonnulls("user_id", "org_unit_id") = 0
    ELSE num_nonnulls("org_unit_id") = 1 AND num_nonnulls("user_id", "member_group_id") = 0
  END
);

-- ── Nested groups never form a cycle ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION group_member_no_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.member_type <> 'GROUP' THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('public_group:' || NEW.tenant_id::text, 0));
  -- Adding G as a member of P is a cycle if P is G, or P is already (transitively) inside G.
  IF NEW.member_group_id = NEW.group_id OR EXISTS (
    WITH RECURSIVE inside(group_id) AS (
      SELECT NEW.member_group_id
      UNION
      SELECT gm.member_group_id FROM group_member gm JOIN inside ON gm.group_id = inside.group_id
      WHERE gm.tenant_id = NEW.tenant_id AND gm.member_type = 'GROUP'
    )
    SELECT 1 FROM inside WHERE group_id = NEW.group_id
  ) THEN
    RAISE EXCEPTION 'public group % cannot contain itself', NEW.group_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'group_member_no_cycle';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER group_member_no_cycle BEFORE INSERT OR UPDATE ON "group_member"
  FOR EACH ROW EXECUTE FUNCTION group_member_no_cycle();

-- ── Membership expansion (current tenant only; RLS applies as well) ────────────────────────
-- Users a public group contains, through nested groups, org units and org-unit subtrees.
CREATE OR REPLACE FUNCTION group_user_ids(p_group uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE g(group_id) AS (
    SELECT p_group
    UNION
    SELECT gm.member_group_id FROM group_member gm JOIN g ON gm.group_id = g.group_id
    WHERE gm.tenant_id = app_current_tenant_id() AND gm.member_type = 'GROUP'
  ), m AS (
    SELECT gm.* FROM group_member gm JOIN g ON gm.group_id = g.group_id
    WHERE gm.tenant_id = app_current_tenant_id()
  )
  SELECT user_id FROM m WHERE member_type = 'USER'
  UNION
  SELECT u.id FROM m JOIN "user" u ON u.tenant_id = m.tenant_id AND u.org_unit_id = m.org_unit_id
  WHERE m.member_type = 'ORG_UNIT'
  UNION
  SELECT u.id FROM m
  JOIN org_unit_closure c ON c.tenant_id = m.tenant_id AND c.ancestor_id = m.org_unit_id
  JOIN "user" u ON u.tenant_id = m.tenant_id AND u.org_unit_id = c.descendant_id
  WHERE m.member_type = 'ORG_UNIT_AND_SUBORDINATES'
$$;

-- Public groups a user belongs to, directly or through their org unit, and every group that
-- (transitively) contains one of those.
CREATE OR REPLACE FUNCTION user_public_group_ids(p_user uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE me AS (
    SELECT org_unit_id FROM "user" WHERE tenant_id = app_current_tenant_id() AND id = p_user
  ), g(group_id) AS (
    SELECT gm.group_id FROM group_member gm
    WHERE gm.tenant_id = app_current_tenant_id() AND (
      (gm.member_type = 'USER' AND gm.user_id = p_user)
      OR (gm.member_type = 'ORG_UNIT' AND gm.org_unit_id = (SELECT org_unit_id FROM me))
      OR (gm.member_type = 'ORG_UNIT_AND_SUBORDINATES' AND EXISTS (
        SELECT 1 FROM org_unit_closure c
        WHERE c.tenant_id = gm.tenant_id AND c.ancestor_id = gm.org_unit_id
          AND c.descendant_id = (SELECT org_unit_id FROM me)))
    )
    UNION
    SELECT gm.group_id FROM group_member gm JOIN g ON gm.member_group_id = g.group_id
    WHERE gm.tenant_id = app_current_tenant_id() AND gm.member_type = 'GROUP'
  )
  SELECT group_id FROM g
$$;

-- Users a queue contains.
CREATE OR REPLACE FUNCTION queue_user_ids(p_queue uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE AS $$
  WITH m AS (
    SELECT * FROM queue_member WHERE tenant_id = app_current_tenant_id() AND queue_id = p_queue
  )
  SELECT user_id FROM m WHERE member_type = 'USER'
  UNION
  SELECT group_user_ids(member_group_id) FROM m WHERE member_type = 'GROUP'
  UNION
  SELECT u.id FROM m JOIN "user" u ON u.tenant_id = m.tenant_id AND u.org_unit_id = m.org_unit_id
  WHERE m.member_type = 'ORG_UNIT'
  UNION
  SELECT u.id FROM m
  JOIN org_unit_closure c ON c.tenant_id = m.tenant_id AND c.ancestor_id = m.org_unit_id
  JOIN "user" u ON u.tenant_id = m.tenant_id AND u.org_unit_id = c.descendant_id
  WHERE m.member_type = 'ORG_UNIT_AND_SUBORDINATES'
$$;

-- Queues a user belongs to.
CREATE OR REPLACE FUNCTION user_queue_ids(p_user uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE AS $$
  WITH me AS (
    SELECT org_unit_id FROM "user" WHERE tenant_id = app_current_tenant_id() AND id = p_user
  )
  SELECT qm.queue_id FROM queue_member qm
  WHERE qm.tenant_id = app_current_tenant_id() AND (
    (qm.member_type = 'USER' AND qm.user_id = p_user)
    OR (qm.member_type = 'GROUP' AND qm.member_group_id IN (SELECT user_public_group_ids(p_user)))
    OR (qm.member_type = 'ORG_UNIT' AND qm.org_unit_id = (SELECT org_unit_id FROM me))
    OR (qm.member_type = 'ORG_UNIT_AND_SUBORDINATES' AND EXISTS (
      SELECT 1 FROM org_unit_closure c
      WHERE c.tenant_id = qm.tenant_id AND c.ancestor_id = qm.org_unit_id
        AND c.descendant_id = (SELECT org_unit_id FROM me)))
  )
$$;

-- ── perm_version (principal sets are cached by it) ─────────────────────────────────────────
CREATE TRIGGER bump_perm_version AFTER INSERT OR UPDATE OR DELETE ON "public_group"
  FOR EACH STATEMENT EXECUTE FUNCTION bump_perm_version();
CREATE TRIGGER bump_perm_version AFTER INSERT OR UPDATE OR DELETE ON "group_member"
  FOR EACH STATEMENT EXECUTE FUNCTION bump_perm_version();
CREATE TRIGGER bump_perm_version AFTER INSERT OR UPDATE OR DELETE ON "queue"
  FOR EACH STATEMENT EXECUTE FUNCTION bump_perm_version();
CREATE TRIGGER bump_perm_version AFTER INSERT OR UPDATE OR DELETE ON "queue_member"
  FOR EACH STATEMENT EXECUTE FUNCTION bump_perm_version();
CREATE TRIGGER bump_perm_version AFTER INSERT OR UPDATE OR DELETE ON "queue_object"
  FOR EACH STATEMENT EXECUTE FUNCTION bump_perm_version();

-- ── Row-level security ─────────────────────────────────────────────────────────────────────
SELECT enable_tenant_rls('public_group');
SELECT enable_tenant_rls('group_member');
SELECT enable_tenant_rls('queue');
SELECT enable_tenant_rls('queue_member');
SELECT enable_tenant_rls('queue_object');
