-- P01 T14: muting sets name what they remove, so their rows need not be dependency-closed
-- (muting Edit alone must not also mute Read). The dependency rules still hold for every
-- granting set (PROFILE, STANDARD); they move from CHECK constraints into a trigger that knows
-- the set's kind. Expand-only: no data changes, and every existing row already satisfies it.

CREATE OR REPLACE FUNCTION check_grant_dependencies() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  set_kind permission_set_kind;
  ok boolean;
BEGIN
  SELECT kind INTO set_kind FROM permission_set
  WHERE tenant_id = NEW.tenant_id AND id = NEW.permission_set_id;
  IF set_kind = 'MUTING' THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'object_permission' THEN
    ok := (NOT NEW.can_create OR NEW.can_read) AND (NOT NEW.can_edit OR NEW.can_read) AND
      (NOT NEW.can_delete OR NEW.can_edit) AND (NOT NEW.view_all OR NEW.can_read) AND
      (NOT NEW.modify_all OR (NEW.can_delete AND NEW.view_all));
  ELSE
    ok := NOT NEW.can_edit OR NEW.can_read;
  END IF;
  IF NOT ok THEN
    RAISE EXCEPTION 'violates %_dependencies: access in permission set % needs what it depends on',
      TG_TABLE_NAME, NEW.permission_set_id
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_dependencies';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER object_permission_dependencies BEFORE INSERT OR UPDATE ON "object_permission"
  FOR EACH ROW EXECUTE FUNCTION check_grant_dependencies();
CREATE TRIGGER field_permission_dependencies BEFORE INSERT OR UPDATE ON "field_permission"
  FOR EACH ROW EXECUTE FUNCTION check_grant_dependencies();

ALTER TABLE "object_permission" DROP CONSTRAINT "object_permission_dependencies";
ALTER TABLE "field_permission" DROP CONSTRAINT "field_permission_edit_needs_read";
