# Entity-relationship diagram

The tables that exist today, by database. Updated at the end of every phase that changes the schema
(P02 adds the metadata engine and core CRM objects). Source of truth: `packages/db/prisma/schema.prisma`
(cell) and `apps/control-api/prisma/schema.prisma` (control plane), plus the SQL migrations beside them.

## Cell database (one per regional cell)

Every tenant table leads its primary key with `tenant_id`, has row-level security **enabled and forced**
(`enable_tenant_rls()`), and is only reachable inside `withTenant()` (golden rule 1). `db:rls-audit` fails CI if a
table without a policy appears. IDs are UUIDv7. `currency` is the one global table, allow-listed by the audit.

```mermaid
erDiagram
    tenant_settings ||--o{ user : "has"
    user ||--o{ user_identity : "signs in with"
    user ||--o{ session : "opens"
    session ||--o{ refresh_token : "rotates"
    user ||--o{ mfa_factor : "enrols"
    user ||--o{ mfa_recovery_code : "holds"
    user ||--o{ auth_token : "is sent"
    user |o--o{ auth_attempt : "attempts"
    currency ||--o{ tenant_settings : "corporate currency"

    tenant_settings {
        uuid tenant_id PK
        text name
        citext slug
        text region
        char3 corporate_currency FK
        text default_locale
        text default_timezone
        smallint fiscal_year_start_month
        int metadata_version
        int perm_version
        uuid owner_user_id
        timestamptz activated_at
        int version
    }
    user {
        uuid tenant_id PK
        uuid id PK
        citext email "unique per tenant"
        timestamptz email_verified_at
        text name
        text locale
        text timezone
        theme_preference theme
        density_preference density
        user_status status
        int version
        timestamptz deleted_at
    }
    user_identity {
        uuid tenant_id PK
        uuid id PK
        uuid user_id FK
        identity_provider provider "password, google, microsoft"
        text subject "unique per tenant and provider"
        text password_hash "argon2id"
    }
    session {
        uuid tenant_id PK
        uuid id PK
        uuid user_id FK
        timestamptz last_seen_at
        text ip
        text user_agent
        bool mfa_verified
        timestamptz revoked_at
    }
    refresh_token {
        uuid tenant_id PK
        uuid id PK
        uuid session_id FK
        uuid family_id "reuse revokes the family"
        uuid parent_id
        bytea token_hash "unique per tenant"
        timestamptz expires_at
        timestamptz used_at
        timestamptz revoked_at
    }
    mfa_factor {
        uuid tenant_id PK
        uuid id PK
        uuid user_id FK
        mfa_factor_type type "totp"
        text secret_enc "SecretBox, AES-256-GCM"
        timestamptz confirmed_at
        bigint last_used_step "TOTP replay guard"
    }
    mfa_recovery_code {
        uuid tenant_id PK
        uuid id PK
        uuid user_id FK
        bytea code_hash
        timestamptz used_at
    }
    auth_token {
        uuid tenant_id PK
        uuid id PK
        uuid user_id FK
        auth_token_purpose purpose "verify_email, reset_password"
        bytea token_hash
        timestamptz expires_at
        timestamptz used_at
    }
    auth_attempt {
        uuid tenant_id PK
        uuid id PK
        uuid user_id FK
        bytea email_hash
        text ip
        bool success
        timestamptz at
        timestamptz locked_until
    }
    idempotency_key {
        uuid tenant_id PK
        text key PK
        bytea request_hash
        int response_status
        jsonb response_body
        timestamptz expires_at
    }
    currency {
        char3 code PK
        text name
        smallint minor_units
    }
```

## Control-plane database (global)

No CRM data and no tenant-scoped rows in the RLS sense: it is the directory that routes a host or an email to a cell.
Emails are stored only as HMACs (spec v1.2).

```mermaid
erDiagram
    cp_cell ||--o{ cp_tenant : "hosts"
    cp_tenant ||--o{ cp_tenant_domain : "answers on"
    cp_tenant ||--o{ cp_user_routing : "is found by"

    cp_cell {
        text id PK "e.g. eu-central-1"
        text region
        text label
        text api_base_url
        text public_key_pem "verifies the cell's service tokens"
        bool signup_open
    }
    cp_tenant {
        uuid id PK
        citext slug "unique"
        text name
        text cell_id FK
        cp_tenant_status status "PENDING, ACTIVE, SUSPENDED"
        bytea owner_email_hmac
        timestamptz reserved_until
        timestamptz activated_at
    }
    cp_tenant_domain {
        citext host PK
        uuid tenant_id FK
    }
    cp_user_routing {
        bytea email_hmac PK
        uuid tenant_id PK
    }
    cp_idempotency_key {
        text scope PK
        text key PK
        bytea request_hash
        int response_status
        jsonb response_body
        timestamptz expires_at
    }
```
