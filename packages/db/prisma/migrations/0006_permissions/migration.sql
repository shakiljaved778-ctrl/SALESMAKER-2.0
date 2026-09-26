-- 0006_permissions — P01 T04: profiles, permission sets and groups, assignments, and the system,
-- object and field grants (§6.2). Additive (expand-only).
-- CreateEnum
CREATE TYPE "permission_set_kind" AS ENUM ('PROFILE', 'STANDARD', 'MUTING');

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "profile_id" UUID;

-- CreateTable
CREATE TABLE "profile" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "system_key" TEXT,
    "permission_set_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "profile_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "permission_set" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "kind" "permission_set_kind" NOT NULL DEFAULT 'STANDARD',
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "permission_set_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "permission_set_group" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "muting_set_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "permission_set_group_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "permission_set_group_member" (
    "tenant_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "permission_set_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "permission_set_group_member_pkey" PRIMARY KEY ("tenant_id","group_id","permission_set_id")
);

-- CreateTable
CREATE TABLE "permission_assignment" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "permission_set_id" UUID,
    "permission_set_group_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "permission_assignment_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "system_permission" (
    "tenant_id" UUID NOT NULL,
    "permission_set_id" UUID NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "system_permission_pkey" PRIMARY KEY ("tenant_id","permission_set_id","name")
);

-- CreateTable
CREATE TABLE "object_permission" (
    "tenant_id" UUID NOT NULL,
    "permission_set_id" UUID NOT NULL,
    "object" TEXT NOT NULL,
    "can_read" BOOLEAN NOT NULL DEFAULT false,
    "can_create" BOOLEAN NOT NULL DEFAULT false,
    "can_edit" BOOLEAN NOT NULL DEFAULT false,
    "can_delete" BOOLEAN NOT NULL DEFAULT false,
    "view_all" BOOLEAN NOT NULL DEFAULT false,
    "modify_all" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "object_permission_pkey" PRIMARY KEY ("tenant_id","permission_set_id","object")
);

-- CreateTable
CREATE TABLE "field_permission" (
    "tenant_id" UUID NOT NULL,
    "permission_set_id" UUID NOT NULL,
    "object" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "can_read" BOOLEAN NOT NULL DEFAULT false,
    "can_edit" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "field_permission_pkey" PRIMARY KEY ("tenant_id","permission_set_id","object","field")
);

-- CreateIndex
CREATE UNIQUE INDEX "profile_tenant_id_name_key" ON "profile"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "profile_tenant_id_system_key_key" ON "profile"("tenant_id", "system_key");

-- CreateIndex
CREATE UNIQUE INDEX "profile_tenant_id_permission_set_id_key" ON "profile"("tenant_id", "permission_set_id");

-- CreateIndex
CREATE UNIQUE INDEX "permission_set_tenant_id_kind_name_key" ON "permission_set"("tenant_id", "kind", "name");

-- CreateIndex
CREATE UNIQUE INDEX "permission_set_group_tenant_id_name_key" ON "permission_set_group"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "permission_set_group_tenant_id_muting_set_id_key" ON "permission_set_group"("tenant_id", "muting_set_id");

-- CreateIndex
CREATE INDEX "permission_set_group_member_tenant_id_permission_set_id_idx" ON "permission_set_group_member"("tenant_id", "permission_set_id");

-- CreateIndex
CREATE INDEX "permission_assignment_tenant_id_permission_set_id_idx" ON "permission_assignment"("tenant_id", "permission_set_id");

-- CreateIndex
CREATE INDEX "permission_assignment_tenant_id_permission_set_group_id_idx" ON "permission_assignment"("tenant_id", "permission_set_group_id");

-- CreateIndex
CREATE UNIQUE INDEX "permission_assignment_tenant_id_user_id_permission_set_id_key" ON "permission_assignment"("tenant_id", "user_id", "permission_set_id");

-- CreateIndex
CREATE UNIQUE INDEX "permission_assignment_tenant_id_user_id_permission_set_grou_key" ON "permission_assignment"("tenant_id", "user_id", "permission_set_group_id");

-- CreateIndex
CREATE INDEX "user_tenant_id_profile_id_idx" ON "user"("tenant_id", "profile_id");

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_tenant_id_profile_id_fkey" FOREIGN KEY ("tenant_id", "profile_id") REFERENCES "profile"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profile" ADD CONSTRAINT "profile_tenant_id_permission_set_id_fkey" FOREIGN KEY ("tenant_id", "permission_set_id") REFERENCES "permission_set"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permission_set_group" ADD CONSTRAINT "permission_set_group_tenant_id_muting_set_id_fkey" FOREIGN KEY ("tenant_id", "muting_set_id") REFERENCES "permission_set"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permission_set_group_member" ADD CONSTRAINT "permission_set_group_member_tenant_id_group_id_fkey" FOREIGN KEY ("tenant_id", "group_id") REFERENCES "permission_set_group"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permission_set_group_member" ADD CONSTRAINT "permission_set_group_member_tenant_id_permission_set_id_fkey" FOREIGN KEY ("tenant_id", "permission_set_id") REFERENCES "permission_set"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permission_assignment" ADD CONSTRAINT "permission_assignment_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "user"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permission_assignment" ADD CONSTRAINT "permission_assignment_tenant_id_permission_set_id_fkey" FOREIGN KEY ("tenant_id", "permission_set_id") REFERENCES "permission_set"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permission_assignment" ADD CONSTRAINT "permission_assignment_tenant_id_permission_set_group_id_fkey" FOREIGN KEY ("tenant_id", "permission_set_group_id") REFERENCES "permission_set_group"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_permission" ADD CONSTRAINT "system_permission_tenant_id_permission_set_id_fkey" FOREIGN KEY ("tenant_id", "permission_set_id") REFERENCES "permission_set"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "object_permission" ADD CONSTRAINT "object_permission_tenant_id_permission_set_id_fkey" FOREIGN KEY ("tenant_id", "permission_set_id") REFERENCES "permission_set"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_permission" ADD CONSTRAINT "field_permission_tenant_id_permission_set_id_fkey" FOREIGN KEY ("tenant_id", "permission_set_id") REFERENCES "permission_set"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Grant invariants ───────────────────────────────────────────────────────────────────────
-- An assignment targets exactly one of a permission set or a permission set group.
ALTER TABLE "permission_assignment" ADD CONSTRAINT "permission_assignment_one_target"
  CHECK (num_nonnulls("permission_set_id", "permission_set_group_id") = 1);
-- Object access is cumulative (Salesforce semantics): create/edit need read, delete needs edit,
-- view all needs read, and modify all needs delete and view all.
ALTER TABLE "object_permission" ADD CONSTRAINT "object_permission_dependencies" CHECK (
  (NOT "can_create" OR "can_read") AND (NOT "can_edit" OR "can_read") AND
  (NOT "can_delete" OR "can_edit") AND (NOT "view_all" OR "can_read") AND
  (NOT "modify_all" OR ("can_delete" AND "view_all"))
);
ALTER TABLE "field_permission" ADD CONSTRAINT "field_permission_edit_needs_read"
  CHECK (NOT "can_edit" OR "can_read");

-- ── Permission set kinds ───────────────────────────────────────────────────────────────────
-- A profile points at a PROFILE set, a group's muting set is a MUTING set, and only STANDARD sets
-- are assigned or grouped. check_permission_set_kind(column, kind) enforces one such rule.
CREATE OR REPLACE FUNCTION check_permission_set_kind() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  set_id uuid := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  actual permission_set_kind;
BEGIN
  IF set_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT kind INTO actual FROM permission_set WHERE tenant_id = NEW.tenant_id AND id = set_id;
  IF actual IS DISTINCT FROM TG_ARGV[1]::permission_set_kind THEN
    RAISE EXCEPTION '%.% must reference a % permission set, not %', TG_TABLE_NAME, TG_ARGV[0],
      TG_ARGV[1], actual
      USING ERRCODE = 'check_violation', CONSTRAINT = 'permission_set_kind';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER profile_set_kind BEFORE INSERT OR UPDATE OF "permission_set_id" ON "profile"
  FOR EACH ROW EXECUTE FUNCTION check_permission_set_kind('permission_set_id', 'PROFILE');
CREATE TRIGGER group_muting_set_kind BEFORE INSERT OR UPDATE OF "muting_set_id" ON "permission_set_group"
  FOR EACH ROW EXECUTE FUNCTION check_permission_set_kind('muting_set_id', 'MUTING');
CREATE TRIGGER group_member_set_kind BEFORE INSERT OR UPDATE OF "permission_set_id" ON "permission_set_group_member"
  FOR EACH ROW EXECUTE FUNCTION check_permission_set_kind('permission_set_id', 'STANDARD');
CREATE TRIGGER assignment_set_kind BEFORE INSERT OR UPDATE OF "permission_set_id" ON "permission_assignment"
  FOR EACH ROW EXECUTE FUNCTION check_permission_set_kind('permission_set_id', 'STANDARD');
-- A set's kind never changes once it exists: the rules above are checked only on the referrer.
CREATE OR REPLACE FUNCTION permission_set_kind_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'the kind of permission set % cannot change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'permission_set_kind';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER permission_set_kind_immutable BEFORE UPDATE OF "kind" ON "permission_set"
  FOR EACH ROW EXECUTE FUNCTION permission_set_kind_immutable();

-- ── perm_version ───────────────────────────────────────────────────────────────────────────
-- Effective permissions and principal sets are cached by tenant_settings.perm_version (§6.4).
-- Any change that can alter them bumps it in the same transaction, so a cache entry can never
-- outlive the data it was computed from. Statement-level: one bump per statement.
CREATE OR REPLACE FUNCTION bump_perm_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE tenant_settings SET perm_version = perm_version + 1
  WHERE tenant_id = app_current_tenant_id();
  RETURN NULL;
END
$$;

CREATE TRIGGER bump_perm_version AFTER INSERT OR UPDATE OR DELETE ON "profile"
  FOR EACH STATEMENT EXECUTE FUNCTION bump_perm_version();
CREATE TRIGGER bump_perm_version AFTER INSERT OR UPDATE OR DELETE ON "permission_set"
  FOR EACH STATEMENT EXECUTE FUNCTION bump_perm_version();
CREATE TRIGGER bump_perm_version AFTER INSERT OR UPDATE OR DELETE ON "permission_set_group"
  FOR EACH STATEMENT EXECUTE FUNCTION bump_perm_version();
CREATE TRIGGER bump_perm_version AFTER INSERT OR UPDATE OR DELETE ON "permission_set_group_member"
  FOR EACH STATEMENT EXECUTE FUNCTION bump_perm_version();
CREATE TRIGGER bump_perm_version AFTER INSERT OR UPDATE OR DELETE ON "permission_assignment"
  FOR EACH STATEMENT EXECUTE FUNCTION bump_perm_version();
CREATE TRIGGER bump_perm_version AFTER INSERT OR UPDATE OR DELETE ON "system_permission"
  FOR EACH STATEMENT EXECUTE FUNCTION bump_perm_version();
CREATE TRIGGER bump_perm_version AFTER INSERT OR UPDATE OR DELETE ON "object_permission"
  FOR EACH STATEMENT EXECUTE FUNCTION bump_perm_version();
CREATE TRIGGER bump_perm_version AFTER INSERT OR UPDATE OR DELETE ON "field_permission"
  FOR EACH STATEMENT EXECUTE FUNCTION bump_perm_version();
-- The hierarchy feeds principal sets and the visibility closure (T03).
CREATE TRIGGER bump_perm_version AFTER INSERT OR DELETE OR UPDATE OF "parent_id" ON "org_unit"
  FOR EACH STATEMENT EXECUTE FUNCTION bump_perm_version();
CREATE TRIGGER bump_perm_version AFTER INSERT OR DELETE
  OR UPDATE OF "profile_id", "org_unit_id", "manager_id", "status", "deactivated_at" ON "user"
  FOR EACH STATEMENT EXECUTE FUNCTION bump_perm_version();

-- ── Row-level security ─────────────────────────────────────────────────────────────────────
SELECT enable_tenant_rls('profile');
SELECT enable_tenant_rls('permission_set');
SELECT enable_tenant_rls('permission_set_group');
SELECT enable_tenant_rls('permission_set_group_member');
SELECT enable_tenant_rls('permission_assignment');
SELECT enable_tenant_rls('system_permission');
SELECT enable_tenant_rls('object_permission');
SELECT enable_tenant_rls('field_permission');
