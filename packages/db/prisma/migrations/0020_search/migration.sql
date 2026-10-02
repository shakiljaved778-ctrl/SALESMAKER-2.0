-- Search v1 (P02 T14, §7.19). Additive: richer weighted vectors, trigram name indexes for typos
-- and reversed-digit phone indexes for suffix matching. The field lists mirror SEARCH_FIELDS in
-- @sm/query-engine (search.ts), which rebuilds the same vector from readable fields only (FLS).

-- Phone digits, reversed: "…000 0000" typed as "0000" matches with an index-friendly prefix LIKE.
CREATE OR REPLACE FUNCTION crm_phone_rev(phone text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT nullif(reverse(regexp_replace(coalesce(phone, ''), '\D', '', 'g')), '')
$$;

-- Text as search tokens: words split on anything not a letter or digit (emails, URLs too).
CREATE OR REPLACE FUNCTION crm_search_words(value text) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT to_tsvector('simple', regexp_replace(coalesce(value, ''), '[^[:alnum:]]+', ' ', 'g'))
$$;

-- Phone numbers as one token of their digits.
CREATE OR REPLACE FUNCTION crm_search_phone(value text) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT to_tsvector('simple', regexp_replace(coalesce(value, ''), '\D', '', 'g'))
$$;

CREATE OR REPLACE FUNCTION crm_search_vector() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Separate branches: PL/pgSQL resolves NEW.<column> only in the branch that runs.
  IF TG_TABLE_NAME = 'lead' THEN
    NEW.search_vector :=
      setweight(crm_search_words(NEW.first_name) || crm_search_words(NEW.last_name)
        || crm_search_words(NEW.email) || crm_search_phone(NEW.phone)
        || crm_search_phone(NEW.mobile_phone), 'A') ||
      setweight(crm_search_words(NEW.company), 'B') ||
      setweight(crm_search_words(NEW.title) || crm_search_words(NEW.city)
        || crm_search_words(NEW.website), 'C');
  ELSIF TG_TABLE_NAME = 'contact' THEN
    NEW.search_vector :=
      setweight(crm_search_words(NEW.first_name) || crm_search_words(NEW.last_name)
        || crm_search_words(NEW.email) || crm_search_phone(NEW.phone)
        || crm_search_phone(NEW.mobile_phone), 'A') ||
      setweight(crm_search_words(NEW.title) || crm_search_words(NEW.department), 'B') ||
      setweight(crm_search_words(NEW.mailing_city), 'C');
  ELSIF TG_TABLE_NAME = 'account' THEN
    NEW.search_vector :=
      setweight(crm_search_words(NEW.name) || crm_search_phone(NEW.phone)
        || crm_search_words(NEW.website), 'A') ||
      setweight(crm_search_words(NEW.billing_city), 'C');
  ELSIF TG_TABLE_NAME = 'opportunity' THEN
    NEW.search_vector :=
      setweight(crm_search_words(NEW.name), 'A') ||
      setweight(crm_search_words(NEW.next_step), 'C');
  ELSE
    NEW.search_vector := setweight(crm_search_words(NEW.name), 'A');
  END IF;
  RETURN NEW;
END
$$;

-- Fire on every insert and update: the vector now spans many columns.
DROP TRIGGER crm_search_vector ON "lead";
DROP TRIGGER crm_search_vector ON "contact";
DROP TRIGGER crm_search_vector ON "account";
DROP TRIGGER crm_search_vector ON "opportunity";
DROP TRIGGER crm_search_vector ON "campaign";
CREATE TRIGGER crm_search_vector BEFORE INSERT OR UPDATE ON "lead"
  FOR EACH ROW EXECUTE FUNCTION crm_search_vector();
CREATE TRIGGER crm_search_vector BEFORE INSERT OR UPDATE ON "contact"
  FOR EACH ROW EXECUTE FUNCTION crm_search_vector();
CREATE TRIGGER crm_search_vector BEFORE INSERT OR UPDATE ON "account"
  FOR EACH ROW EXECUTE FUNCTION crm_search_vector();
CREATE TRIGGER crm_search_vector BEFORE INSERT OR UPDATE ON "opportunity"
  FOR EACH ROW EXECUTE FUNCTION crm_search_vector();
CREATE TRIGGER crm_search_vector BEFORE INSERT OR UPDATE ON "campaign"
  FOR EACH ROW EXECUTE FUNCTION crm_search_vector();

-- Recompute existing rows (the trigger fires on this no-op update).
UPDATE "lead" SET search_vector = NULL;
UPDATE "contact" SET search_vector = NULL;
UPDATE "account" SET search_vector = NULL;
UPDATE "opportunity" SET search_vector = NULL;
UPDATE "campaign" SET search_vector = NULL;

-- Typo tolerance on names (word similarity, pg_trgm), tenant-leading (btree_gin).
CREATE INDEX "lead_name_trgm" ON "lead" USING gin ("tenant_id",
  (coalesce("first_name", '') || ' ' || coalesce("last_name", '') || ' ' || coalesce("company", '')) gin_trgm_ops)
  WHERE "deleted_at" IS NULL;
CREATE INDEX "contact_name_trgm" ON "contact" USING gin ("tenant_id",
  (coalesce("first_name", '') || ' ' || coalesce("last_name", '')) gin_trgm_ops)
  WHERE "deleted_at" IS NULL;
CREATE INDEX "account_name_trgm" ON "account" USING gin ("tenant_id", "name" gin_trgm_ops)
  WHERE "deleted_at" IS NULL;
CREATE INDEX "opportunity_name_trgm" ON "opportunity" USING gin ("tenant_id", "name" gin_trgm_ops)
  WHERE "deleted_at" IS NULL;
CREATE INDEX "campaign_name_trgm" ON "campaign" USING gin ("tenant_id", "name" gin_trgm_ops)
  WHERE "deleted_at" IS NULL;

-- Phone suffix matching.
CREATE INDEX "lead_phone_rev" ON "lead" ("tenant_id", crm_phone_rev("phone") text_pattern_ops)
  WHERE "deleted_at" IS NULL AND "phone" IS NOT NULL;
CREATE INDEX "lead_mobile_rev" ON "lead" ("tenant_id", crm_phone_rev("mobile_phone") text_pattern_ops)
  WHERE "deleted_at" IS NULL AND "mobile_phone" IS NOT NULL;
CREATE INDEX "contact_phone_rev" ON "contact" ("tenant_id", crm_phone_rev("phone") text_pattern_ops)
  WHERE "deleted_at" IS NULL AND "phone" IS NOT NULL;
CREATE INDEX "contact_mobile_rev" ON "contact" ("tenant_id", crm_phone_rev("mobile_phone") text_pattern_ops)
  WHERE "deleted_at" IS NULL AND "mobile_phone" IS NOT NULL;
CREATE INDEX "account_phone_rev" ON "account" ("tenant_id", crm_phone_rev("phone") text_pattern_ops)
  WHERE "deleted_at" IS NULL AND "phone" IS NOT NULL;
