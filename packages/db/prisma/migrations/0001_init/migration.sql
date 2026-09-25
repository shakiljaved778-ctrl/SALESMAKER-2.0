-- 0001_init — P00 cell schema.
-- Runs as sm_migrator (the schema owner). Roles, database ownership and extensions are created
-- beforehand by `pnpm db:bootstrap` (packages/db/scripts/bootstrap.js) with an admin connection.

-- ── Default privileges: the runtime role reads and writes rows, never owns or alters tables ──
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sm_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO sm_readonly_reports;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO sm_app;

-- ── Helpers ────────────────────────────────────────────────────────────────────────────────
-- UUIDv7 (time-sortable, §4.1). PG16 has no native uuidv7(): take a v4 UUID, overlay the
-- 48-bit Unix-millisecond timestamp, and set the version nibble from 0100 to 0111.
CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid
LANGUAGE sql VOLATILE PARALLEL SAFE AS $$
  SELECT encode(
    set_bit(set_bit(
      overlay(uuid_send(gen_random_uuid())
        placing substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
        FROM 1 FOR 6),
      52, 1), 53, 1),
    'hex')::uuid
$$;

-- The tenant of the current transaction. NULLIF because a pooled connection that once ran
-- set_config(..., true) reports '' (not NULL) after the transaction ends, and '' must never cast.
CREATE OR REPLACE FUNCTION app_current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- enable_tenant_rls(table): the only way tenant tables get RLS (§3.5). ENABLE + FORCE, so even
-- the table owner is subject to the policy; USING and WITH CHECK pin rows to the transaction's
-- tenant. With no tenant set, app_current_tenant_id() is NULL and no row matches.
CREATE OR REPLACE FUNCTION enable_tenant_rls(t regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', t);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (tenant_id = app_current_tenant_id()) '
    'WITH CHECK (tenant_id = app_current_tenant_id())', t);
END
$$;
REVOKE ALL ON FUNCTION enable_tenant_rls(regclass) FROM PUBLIC;


-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('PENDING', 'ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "theme_preference" AS ENUM ('light', 'dark', 'system');

-- CreateEnum
CREATE TYPE "density_preference" AS ENUM ('comfortable', 'default', 'compact');

-- CreateEnum
CREATE TYPE "identity_provider" AS ENUM ('password', 'google', 'microsoft');

-- CreateEnum
CREATE TYPE "mfa_factor_type" AS ENUM ('totp');

-- CreateEnum
CREATE TYPE "auth_token_purpose" AS ENUM ('verify_email', 'reset_password');

-- CreateTable
CREATE TABLE "currency" (
    "code" CHAR(3) NOT NULL,
    "name" TEXT NOT NULL,
    "minor_units" SMALLINT NOT NULL,

    CONSTRAINT "currency_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "tenant_settings" (
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" CITEXT NOT NULL,
    "region" TEXT NOT NULL,
    "corporate_currency" CHAR(3) NOT NULL,
    "default_locale" TEXT NOT NULL DEFAULT 'en',
    "default_timezone" TEXT NOT NULL,
    "fiscal_year_start_month" SMALLINT NOT NULL DEFAULT 1,
    "metadata_version" INTEGER NOT NULL DEFAULT 1,
    "perm_version" INTEGER NOT NULL DEFAULT 1,
    "logo_file_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "tenant_settings_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "user" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "email" CITEXT NOT NULL,
    "email_verified_at" TIMESTAMPTZ(6),
    "name" TEXT NOT NULL,
    "locale" TEXT,
    "timezone" TEXT,
    "theme" "theme_preference" NOT NULL DEFAULT 'system',
    "density" "density_preference" NOT NULL DEFAULT 'default',
    "status" "user_status" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "user_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "user_identity" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "provider" "identity_provider" NOT NULL,
    "subject" TEXT NOT NULL,
    "password_hash" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_identity_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "session" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "user_agent" TEXT,
    "mfa_verified" BOOLEAN NOT NULL DEFAULT false,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "session_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "refresh_token" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "session_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "parent_id" UUID,
    "token_hash" BYTEA NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "mfa_factor" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "type" "mfa_factor_type" NOT NULL,
    "secret_enc" TEXT NOT NULL,
    "confirmed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_factor_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "mfa_recovery_code" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "code_hash" BYTEA NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_recovery_code_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "auth_token" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "purpose" "auth_token_purpose" NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_token_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "auth_attempt" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID,
    "email_hash" BYTEA NOT NULL,
    "ip" TEXT,
    "success" BOOLEAN NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_attempt_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" BYTEA NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("tenant_id","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_tenant_id_email_key" ON "user"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "user_identity_tenant_id_user_id_idx" ON "user_identity"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_identity_tenant_id_provider_subject_key" ON "user_identity"("tenant_id", "provider", "subject");

-- CreateIndex
CREATE INDEX "session_tenant_id_user_id_idx" ON "session"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "refresh_token_tenant_id_family_id_idx" ON "refresh_token"("tenant_id", "family_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_token_tenant_id_token_hash_key" ON "refresh_token"("tenant_id", "token_hash");

-- CreateIndex
CREATE INDEX "mfa_factor_tenant_id_user_id_idx" ON "mfa_factor"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "mfa_recovery_code_tenant_id_user_id_idx" ON "mfa_recovery_code"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "auth_token_tenant_id_user_id_purpose_idx" ON "auth_token"("tenant_id", "user_id", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "auth_token_tenant_id_token_hash_key" ON "auth_token"("tenant_id", "token_hash");

-- CreateIndex
CREATE INDEX "auth_attempt_tenant_id_email_hash_at_idx" ON "auth_attempt"("tenant_id", "email_hash", "at");

-- CreateIndex
CREATE INDEX "idempotency_key_tenant_id_expires_at_idx" ON "idempotency_key"("tenant_id", "expires_at");

-- AddForeignKey
ALTER TABLE "user_identity" ADD CONSTRAINT "user_identity_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "user"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "user"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_tenant_id_session_id_fkey" FOREIGN KEY ("tenant_id", "session_id") REFERENCES "session"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_factor" ADD CONSTRAINT "mfa_factor_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "user"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_recovery_code" ADD CONSTRAINT "mfa_recovery_code_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "user"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_token" ADD CONSTRAINT "auth_token_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "user"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Row-level security on every tenant table ───────────────────────────────────────────────
SELECT enable_tenant_rls('tenant_settings');
SELECT enable_tenant_rls('"user"');
SELECT enable_tenant_rls('user_identity');
SELECT enable_tenant_rls('session');
SELECT enable_tenant_rls('refresh_token');
SELECT enable_tenant_rls('mfa_factor');
SELECT enable_tenant_rls('mfa_recovery_code');
SELECT enable_tenant_rls('auth_token');
SELECT enable_tenant_rls('auth_attempt');
SELECT enable_tenant_rls('idempotency_key');

-- ── Reference data: currencies (global table, allow-listed in the RLS audit) ───────────────
-- Codes from ISO 4217 as supported by ICU. minor_units is the CLDR display precision, used for
-- formatting only; stored money is always numeric(18,2) (golden rule 8).
INSERT INTO "currency" ("code", "name", "minor_units") VALUES
  ('AED', 'United Arab Emirates Dirham', 2),
  ('AFN', 'Afghan Afghani', 0),
  ('ALL', 'Albanian Lek', 0),
  ('AMD', 'Armenian Dram', 2),
  ('ANG', 'Netherlands Antillean Guilder', 2),
  ('AOA', 'Angolan Kwanza', 2),
  ('ARS', 'Argentine Peso', 2),
  ('AUD', 'Australian Dollar', 2),
  ('AWG', 'Aruban Florin', 2),
  ('AZN', 'Azerbaijani Manat', 2),
  ('BAM', 'Bosnia-Herzegovina Convertible Mark', 2),
  ('BBD', 'Barbadian Dollar', 2),
  ('BDT', 'Bangladeshi Taka', 2),
  ('BGN', 'Bulgarian Lev', 2),
  ('BHD', 'Bahraini Dinar', 3),
  ('BIF', 'Burundian Franc', 0),
  ('BMD', 'Bermudan Dollar', 2),
  ('BND', 'Brunei Dollar', 2),
  ('BOB', 'Bolivian Boliviano', 2),
  ('BRL', 'Brazilian Real', 2),
  ('BSD', 'Bahamian Dollar', 2),
  ('BTN', 'Bhutanese Ngultrum', 2),
  ('BWP', 'Botswanan Pula', 2),
  ('BYN', 'Belarusian Ruble', 2),
  ('BZD', 'Belize Dollar', 2),
  ('CAD', 'Canadian Dollar', 2),
  ('CDF', 'Congolese Franc', 2),
  ('CHF', 'Swiss Franc', 2),
  ('CLP', 'Chilean Peso', 0),
  ('CNY', 'Chinese Yuan', 2),
  ('COP', 'Colombian Peso', 0),
  ('CRC', 'Costa Rican Colón', 2),
  ('CUC', 'Cuban Convertible Peso', 2),
  ('CUP', 'Cuban Peso', 2),
  ('CVE', 'Cape Verdean Escudo', 2),
  ('CZK', 'Czech Koruna', 2),
  ('DJF', 'Djiboutian Franc', 0),
  ('DKK', 'Danish Krone', 2),
  ('DOP', 'Dominican Peso', 2),
  ('DZD', 'Algerian Dinar', 2),
  ('EGP', 'Egyptian Pound', 2),
  ('ERN', 'Eritrean Nakfa', 2),
  ('ETB', 'Ethiopian Birr', 2),
  ('EUR', 'Euro', 2),
  ('FJD', 'Fijian Dollar', 2),
  ('FKP', 'Falkland Islands Pound', 2),
  ('GBP', 'British Pound', 2),
  ('GEL', 'Georgian Lari', 2),
  ('GHS', 'Ghanaian Cedi', 2),
  ('GIP', 'Gibraltar Pound', 2),
  ('GMD', 'Gambian Dalasi', 2),
  ('GNF', 'Guinean Franc', 0),
  ('GTQ', 'Guatemalan Quetzal', 2),
  ('GYD', 'Guyanaese Dollar', 2),
  ('HKD', 'Hong Kong Dollar', 2),
  ('HNL', 'Honduran Lempira', 2),
  ('HRK', 'Croatian Kuna', 2),
  ('HTG', 'Haitian Gourde', 2),
  ('HUF', 'Hungarian Forint', 0),
  ('IDR', 'Indonesian Rupiah', 0),
  ('ILS', 'Israeli New Shekel', 2),
  ('INR', 'Indian Rupee', 2),
  ('IQD', 'Iraqi Dinar', 0),
  ('IRR', 'Iranian Rial', 0),
  ('ISK', 'Icelandic Króna', 0),
  ('JMD', 'Jamaican Dollar', 2),
  ('JOD', 'Jordanian Dinar', 3),
  ('JPY', 'Japanese Yen', 0),
  ('KES', 'Kenyan Shilling', 2),
  ('KGS', 'Kyrgyz Som', 2),
  ('KHR', 'Cambodian Riel', 2),
  ('KMF', 'Comorian Franc', 0),
  ('KPW', 'North Korean Won', 0),
  ('KRW', 'South Korean Won', 0),
  ('KWD', 'Kuwaiti Dinar', 3),
  ('KYD', 'Cayman Islands Dollar', 2),
  ('KZT', 'Kazakhstani Tenge', 2),
  ('LAK', 'Laotian Kip', 0),
  ('LBP', 'Lebanese Pound', 0),
  ('LKR', 'Sri Lankan Rupee', 2),
  ('LRD', 'Liberian Dollar', 2),
  ('LSL', 'Lesotho Loti', 2),
  ('LYD', 'Libyan Dinar', 3),
  ('MAD', 'Moroccan Dirham', 2),
  ('MDL', 'Moldovan Leu', 2),
  ('MGA', 'Malagasy Ariary', 0),
  ('MKD', 'Macedonian Denar', 2),
  ('MMK', 'Myanmar Kyat', 0),
  ('MNT', 'Mongolian Tugrik', 2),
  ('MOP', 'Macanese Pataca', 2),
  ('MRU', 'Mauritanian Ouguiya', 2),
  ('MUR', 'Mauritian Rupee', 2),
  ('MVR', 'Maldivian Rufiyaa', 2),
  ('MWK', 'Malawian Kwacha', 2),
  ('MXN', 'Mexican Peso', 2),
  ('MYR', 'Malaysian Ringgit', 2),
  ('MZN', 'Mozambican Metical', 2),
  ('NAD', 'Namibian Dollar', 2),
  ('NGN', 'Nigerian Naira', 2),
  ('NIO', 'Nicaraguan Córdoba', 2),
  ('NOK', 'Norwegian Krone', 2),
  ('NPR', 'Nepalese Rupee', 2),
  ('NZD', 'New Zealand Dollar', 2),
  ('OMR', 'Omani Rial', 3),
  ('PAB', 'Panamanian Balboa', 2),
  ('PEN', 'Peruvian Sol', 2),
  ('PGK', 'Papua New Guinean Kina', 2),
  ('PHP', 'Philippine Peso', 2),
  ('PKR', 'Pakistani Rupee', 0),
  ('PLN', 'Polish Zloty', 2),
  ('PYG', 'Paraguayan Guarani', 0),
  ('QAR', 'Qatari Riyal', 2),
  ('RON', 'Romanian Leu', 2),
  ('RSD', 'Serbian Dinar', 2),
  ('RUB', 'Russian Ruble', 2),
  ('RWF', 'Rwandan Franc', 0),
  ('SAR', 'Saudi Riyal', 2),
  ('SBD', 'Solomon Islands Dollar', 2),
  ('SCR', 'Seychellois Rupee', 2),
  ('SDG', 'Sudanese Pound', 2),
  ('SEK', 'Swedish Krona', 2),
  ('SGD', 'Singapore Dollar', 2),
  ('SHP', 'St. Helena Pound', 2),
  ('SLE', 'Sierra Leonean Leone', 2),
  ('SLL', 'Sierra Leonean Leone (1964—2022)', 0),
  ('SOS', 'Somali Shilling', 0),
  ('SRD', 'Surinamese Dollar', 2),
  ('SSP', 'South Sudanese Pound', 2),
  ('STN', 'São Tomé & Príncipe Dobra', 2),
  ('SVC', 'Salvadoran Colón', 2),
  ('SYP', 'Syrian Pound', 0),
  ('SZL', 'Swazi Lilangeni', 2),
  ('THB', 'Thai Baht', 2),
  ('TJS', 'Tajikistani Somoni', 2),
  ('TMT', 'Turkmenistani Manat', 2),
  ('TND', 'Tunisian Dinar', 3),
  ('TOP', 'Tongan Paʻanga', 2),
  ('TRY', 'Turkish Lira', 2),
  ('TTD', 'Trinidad & Tobago Dollar', 2),
  ('TWD', 'New Taiwan Dollar', 2),
  ('TZS', 'Tanzanian Shilling', 2),
  ('UAH', 'Ukrainian Hryvnia', 2),
  ('UGX', 'Ugandan Shilling', 0),
  ('USD', 'US Dollar', 2),
  ('UYU', 'Uruguayan Peso', 2),
  ('UZS', 'Uzbekistani Som', 2),
  ('VES', 'Venezuelan Bolívar', 2),
  ('VND', 'Vietnamese Dong', 0),
  ('VUV', 'Vanuatu Vatu', 0),
  ('WST', 'Samoan Tala', 2),
  ('XAF', 'Central African CFA Franc', 0),
  ('XCD', 'East Caribbean Dollar', 2),
  ('XCG', 'Caribbean guilder', 2),
  ('XDR', 'Special Drawing Rights', 2),
  ('XOF', 'West African CFA Franc', 0),
  ('XPF', 'CFP Franc', 0),
  ('XSU', 'Sucre', 2),
  ('YER', 'Yemeni Rial', 0),
  ('ZAR', 'South African Rand', 2),
  ('ZMW', 'Zambian Kwacha', 2),
  ('ZWG', 'Zimbabwean Gold', 2),
  ('ZWL', 'Zimbabwean Dollar (2009–2024)', 2)
ON CONFLICT ("code") DO NOTHING;
