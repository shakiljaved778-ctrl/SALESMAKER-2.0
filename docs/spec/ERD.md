# Entity-relationship diagram

The tables that exist today, by database. Updated at the end of every phase that changes the schema
(P01 added hierarchy, permissions, sharing and governance; P02 adds the metadata engine and core CRM objects). Source of truth: `packages/db/prisma/schema.prisma`
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
        uuid org_unit_id FK "P01"
        uuid manager_id FK "P01, cycle-checked"
        uuid profile_id FK "P01"
        text title
        text department
        text phone
        timestamptz deactivated_at
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

### Hierarchy and permissions (P01)

The org tree keeps a closure table (every ancestor–descendant pair with its depth), maintained in the same
transaction by SQL functions; a move rewrites the subtree's paths and refuses cycles. A profile _is_ a permission
set of kind `PROFILE`, so one set of grant tables serves profiles, permission sets and muting sets. Every grant change
bumps `tenant_settings.perm_version` through triggers, which retires cached effective permissions and principals.

```mermaid
erDiagram
    org_unit ||--o{ org_unit : "parent of"
    org_unit ||--o{ org_unit_closure : "ancestor / descendant"
    org_unit ||--o{ user : "places"
    user ||--o{ user : "manages"
    profile ||--|| permission_set : "grants through"
    profile ||--o{ user : "is assigned"
    user ||--o{ permission_assignment : "receives"
    permission_assignment }o--o| permission_set : "a set"
    permission_assignment }o--o| permission_set_group : "or a group"
    permission_set_group ||--o{ permission_set_group_member : "bundles"
    permission_set_group_member }o--|| permission_set : "member"
    permission_set_group |o--o| permission_set : "muted by (kind MUTING)"
    permission_set ||--o{ system_permission : "grants"
    permission_set ||--o{ object_permission : "grants"
    permission_set ||--o{ field_permission : "grants"
    user ||--o{ invitation : "is invited by"

    org_unit {
        uuid tenant_id PK
        uuid id PK
        uuid parent_id FK
        text name
        int version
    }
    org_unit_closure {
        uuid tenant_id PK
        uuid ancestor_id PK
        uuid descendant_id PK
        int depth "0 = itself"
    }
    profile {
        uuid tenant_id PK
        uuid id PK
        text name
        text system_key "built-in profiles"
        uuid permission_set_id FK
    }
    permission_set {
        uuid tenant_id PK
        uuid id PK
        permission_set_kind kind "PROFILE, STANDARD, MUTING"
        text name
    }
    permission_set_group {
        uuid tenant_id PK
        uuid id PK
        text name
        uuid muting_set_id FK
    }
    permission_assignment {
        uuid tenant_id PK
        uuid id PK
        uuid user_id FK
        uuid permission_set_id FK "exactly one of the two"
        uuid permission_set_group_id FK
    }
    system_permission {
        uuid tenant_id PK
        uuid permission_set_id PK
        text name PK "e.g. view_setup, manage_users"
    }
    object_permission {
        uuid tenant_id PK
        uuid permission_set_id PK
        text object PK "standard object API name"
        bool can_read
        bool can_create
        bool can_edit
        bool can_delete
        bool view_all
        bool modify_all
    }
    field_permission {
        uuid tenant_id PK
        uuid permission_set_id PK
        text object PK
        text field PK
        bool can_read
        bool can_edit
    }
    invitation {
        uuid tenant_id PK
        uuid id PK
        uuid user_id FK
        bytea token_hash "single use, 7 days"
        uuid invited_by
        timestamptz expires_at
        timestamptz accepted_at
        timestamptz revoked_at
    }
```

### Groups, queues and sharing (P01)

Groups and queues take users, other groups, org units, or org units with everything below them; membership is
expanded transitively with cycle protection. `user_visibility_closure` lists, per viewer, the owners whose records
hierarchy access shows them (their own, their reports', and everyone's in units below theirs, plus their queues).
`record_share` is LIST-partitioned by object (one partition per standard object plus a default).

```mermaid
erDiagram
    public_group ||--o{ group_member : "contains"
    queue ||--o{ queue_member : "contains"
    queue ||--o{ queue_object : "holds records of"
    user ||--o{ user_visibility_closure : "views (viewer)"
    user ||--o{ user_visibility_closure : "is seen (owner)"
    sharing_rule ||--o{ record_share : "writes (reason RULE)"
    sharing_rule ||--o{ job_run : "recalculated by"

    public_group {
        uuid tenant_id PK
        uuid id PK
        text name
    }
    group_member {
        uuid tenant_id PK
        uuid id PK
        uuid group_id FK
        member_type member_type "USER, GROUP, ORG_UNIT, ORG_UNIT_AND_SUBORDINATES"
        uuid user_id
        uuid member_group_id
        uuid org_unit_id
    }
    queue {
        uuid tenant_id PK
        uuid id PK
        text name
        citext email
    }
    queue_member {
        uuid tenant_id PK
        uuid id PK
        uuid queue_id FK
        member_type member_type
    }
    queue_object {
        uuid tenant_id PK
        uuid queue_id PK
        text object PK
    }
    org_wide_default {
        uuid tenant_id PK
        text object PK
        sharing_model sharing_model "PRIVATE, PUBLIC_READ, PUBLIC_READ_WRITE, CONTROLLED_BY_PARENT"
        bool grant_hierarchy
    }
    user_visibility_closure {
        uuid tenant_id PK
        uuid viewer_user_id PK
        uuid owner_id PK
    }
    record_share {
        uuid tenant_id PK
        text object PK "partition key"
        uuid id PK
        uuid record_id
        share_principal_type principal_type "USER, GROUP, QUEUE, ORG_UNIT, ORG_UNIT_AND_SUBORDINATES"
        uuid principal_id
        smallint access "1 read, 2 edit, 3 full"
        share_reason reason "RULE, MANUAL, TEAM, TERRITORY, IMPLICIT_PARENT, IMPLICIT_CHILD"
        uuid source_id "the rule, for RULE shares"
    }
    sharing_rule {
        uuid tenant_id PK
        uuid id PK
        text object
        sharing_rule_kind kind "OWNER, CRITERIA"
        share_principal_type source_type
        uuid source_id
        jsonb criteria "filter tree"
        share_principal_type target_type
        uuid target_id
        smallint access
        bool active
    }
    job_run {
        uuid tenant_id PK
        uuid id PK
        text kind
        uuid subject_id
        job_run_status status
        int done
        int total
        text error
    }
```

### Governance and jobs (P01)

`audit_log` is partitioned monthly and INSERT-only for `sm_app`; only the `sm_audit` role sets `hash` and
`prev_hash`. Rows are written in the audited transaction and chained by the worker in batches, each with a Merkle
root linked to the previous batch (ADR-0008, P01 plan §3.3). `outbox_event` is partitioned daily and kept 7 days.

```mermaid
erDiagram
    audit_log }o--|| audit_batch : "chained in"
    audit_batch ||--o| audit_batch : "prev_root"
    audit_verification }o--|| audit_log : "verified through seq"

    audit_log {
        uuid tenant_id PK
        uuid id PK
        timestamptz occurred_at "partition key"
        bigint seq "per tenant, gap-declared"
        text actor_type "user, system, agent, support"
        uuid actor_id
        uuid on_behalf_of
        text action
        text object
        uuid record_id
        jsonb payload
        text request_id
        text prev_hash
        text hash
        timestamptz chained_at
    }
    audit_batch {
        uuid tenant_id PK
        uuid id PK
        bigint first_seq
        bigint last_seq
        int row_count
        bigint_array gaps
        text head_hash
        text merkle_root
        text prev_root
    }
    audit_verification {
        uuid tenant_id PK
        uuid id PK
        audit_verification_status status "OK, BROKEN"
        bigint through_seq
        int rows
        int pending
        text problem
    }
    setup_audit {
        uuid tenant_id PK
        uuid id PK
        timestamptz occurred_at
        uuid actor_id
        text action
        text entity_type
        uuid entity_id
        text entity_name
        jsonb before
        jsonb after
    }
    login_history {
        uuid tenant_id PK
        uuid id PK
        timestamptz occurred_at
        uuid user_id
        bytea email_hash
        login_method method
        login_outcome outcome
        uuid session_id
        text ip
        text user_agent
    }
    outbox_event {
        uuid tenant_id PK
        uuid id PK
        timestamptz created_at "partition key"
        bigint seq
        text topic
        text aggregate_type
        uuid aggregate_id
        jsonb payload
        timestamptz published_at
    }
```

### Metadata (P02)

Every CRM object is described by metadata, synced from the standard catalogue (`syncStandardMetadata`, insert-only,
`tenant_settings.catalogue_version`) and extended by admins in Setup. Standard fields point at typed columns of the
object tables; custom fields at keys of their `custom jsonb`. Every change bumps `tenant_settings.metadata_version`,
which retires cached metadata. See [metadata](../modules/metadata.md).

```mermaid
erDiagram
    object_definition ||--o{ field_definition : "has"
    field_definition ||--o{ picklist_value : "offers"
    object_definition ||--o{ record_type : "has"
    record_type ||--o{ record_type_picklist : "limits"
    record_type_picklist }o--|| picklist_value : "value"
    record_type }o--o| pipeline : "uses (opportunity)"
    object_definition ||--o{ page_layout : "has"
    page_layout ||--o{ layout_assignment : "assigned"
    layout_assignment }o--|| profile : "for profile"
    layout_assignment }o--|| record_type : "and record type"
    object_definition ||--o{ compact_layout : "has"
    record_type ||--o{ path_setting : "has"
    path_setting }o--|| field_definition : "on picklist"
    object_definition ||--o{ validation_rule : "has"
    field_definition ||--o| auto_number_sequence : "numbers"
    field_definition ||--o| custom_field_index : "indexed by (ADR-0030)"
    object_definition ||--o{ list_view : "has"
    list_view ||--o{ list_view_pin : "pinned by user"

    object_definition {
        uuid tenant_id PK
        uuid id PK
        text api_name "lead, account, …"
        boolean is_standard
        text label_singular
        text label_plural
        text record_number_prefix
        text name_field
        jsonb features
    }
    field_definition {
        uuid tenant_id PK
        uuid id PK
        uuid object_id FK
        text api_name "x or x__c, never changes"
        field_type type
        text label "null = translated standard label"
        boolean required
        boolean track_history "≤ 60 per object"
        boolean indexed
        int length
        int precision
        int scale
        text_array reference_to "lookups"
        jsonb default_value
        text formula
    }
    picklist_value {
        uuid tenant_id PK
        uuid id PK
        uuid field_id FK
        text api_value "lower snake_case"
        text label
        text category "lead status, forecast"
        boolean is_default
        boolean active "values are never removed"
    }
    record_type {
        uuid tenant_id PK
        uuid id PK
        uuid object_id FK
        text api_name
        text name
        boolean is_default
        boolean active
        uuid pipeline_id FK
    }
    page_layout {
        uuid tenant_id PK
        uuid id PK
        uuid object_id FK
        text name
        boolean is_default
        jsonb sections
        jsonb related_lists
    }
    layout_assignment {
        uuid tenant_id PK
        uuid profile_id PK
        uuid record_type_id PK
        uuid page_layout_id FK
    }
    path_setting {
        uuid tenant_id PK
        uuid id PK
        uuid record_type_id FK
        uuid field_id FK
        boolean active
        jsonb steps "key fields, guidance"
    }
    validation_rule {
        uuid tenant_id PK
        uuid id PK
        uuid object_id FK
        text api_name
        text formula "Boolean, @sm/formula"
        text error_message
        text error_field
        boolean active
    }
    list_view {
        uuid tenant_id PK
        uuid id PK
        uuid object_id FK
        text system_key "all, mine, recent"
        uuid owner_id FK
        list_view_visibility visibility "PRIVATE, GROUPS, ALL"
        jsonb filter "SMQ where"
        text_array columns
        jsonb sort
    }
    custom_field_index {
        uuid tenant_id PK
        uuid field_id PK
        custom_field_index_status status "PENDING, READY, FAILED"
        text index_name
        text error
    }
```

### Core CRM objects (P02)

Lead, account, contact, opportunity and campaign share the §4.1 columns (`tenant_id`, `id`, `record_number`,
`owner_id`, `record_type_id`, `external_id` unique per tenant, created/updated by and at, `version`,
`deleted_at`), a `custom jsonb` for custom fields and a trigger-maintained `search_vector`. Money objects add
`currency_code`, one `<field>_corporate` per standard currency field and `corporate_rate_date` (ADR-0031). CRM
lookups are logical references (no foreign keys; RecordService checks them, the purge clears them). Shares live in
`record_share` (P01), including the TEAM and IMPLICIT shares RecordService derives. See [records](../modules/records.md).

```mermaid
erDiagram
    account ||--o{ account : "parent of"
    account ||--o{ contact : "employs"
    account ||--o{ account_contact_relation : "relates"
    account_contact_relation }o--|| contact : "contact"
    account ||--o{ opportunity : "has"
    pipeline ||--o{ pipeline_stage : "stages"
    pipeline ||--o{ opportunity : "tracks"
    opportunity ||--o{ opportunity_contact_role : "involves"
    opportunity_contact_role }o--|| contact : "contact"
    opportunity ||--o{ opportunity_stage_history : "moves through"
    campaign ||--o{ campaign_member : "has"
    campaign_member }o--o| lead : "lead"
    campaign_member }o--o| contact : "or contact"
    campaign ||--o{ campaign : "parent of"
    lead ||--o| lead_conversion : "converted by"
    lead_conversion }o--|| account : "into"
    lead_conversion }o--|| contact : "into"
    lead_conversion }o--o| opportunity : "and maybe"
    account ||--o{ account_team_member : "team"
    opportunity ||--o{ opportunity_team_member : "team"

    lead {
        uuid tenant_id PK
        uuid id PK
        text record_number "auto-number"
        uuid owner_id "user or queue"
        text first_name
        text last_name
        text company
        text email
        text phone "E.164, reversed-digit index"
        text status "picklist with category"
        numeric annual_revenue "and _corporate"
        uuid campaign_id
        timestamptz converted_at "and converted_* ids"
        jsonb custom
        tsvector search_vector
        int version
        timestamptz deleted_at
    }
    account {
        uuid tenant_id PK
        uuid id PK
        text name
        uuid parent_account_id
        text type
        text industry
        numeric annual_revenue "and _corporate"
        text billing_city "and address"
        char currency_code
        jsonb custom
        tsvector search_vector
    }
    contact {
        uuid tenant_id PK
        uuid id PK
        text first_name
        text last_name
        uuid account_id "primary account, CONTROLLED_BY_PARENT"
        uuid reports_to_id
        text email
        date birthdate
        jsonb custom
        tsvector search_vector
    }
    opportunity {
        uuid tenant_id PK
        uuid id PK
        text name
        uuid account_id
        uuid pipeline_id
        text stage
        numeric probability
        text forecast_category
        numeric amount "numeric(18,2)"
        numeric amount_corporate "rate on close_date"
        date close_date
        char currency_code
        date corporate_rate_date
        boolean is_closed
        boolean is_won
        text loss_reason
    }
    campaign {
        uuid tenant_id PK
        uuid id PK
        text name
        uuid parent_campaign_id
        text status
        date start_date
        date end_date
        numeric budgeted_cost "and actual, expected"
    }
    pipeline_stage {
        uuid tenant_id PK
        uuid id PK
        uuid pipeline_id FK
        text api_value
        text category "OPEN, WON, LOST"
        numeric probability
        text forecast_category
    }
    lead_conversion {
        uuid tenant_id PK
        uuid id PK
        uuid lead_id
        uuid account_id
        uuid contact_id
        uuid opportunity_id
        jsonb record_versions "for undo within 24 h"
        timestamptz converted_at
        timestamptz undone_at
    }
    account_team_member {
        uuid tenant_id PK
        uuid id PK
        uuid account_id
        uuid user_id
        smallint access
        smallint opportunity_access
    }
```

### Record support and currencies (P02)

```mermaid
erDiagram
    tenant_settings ||--o{ tenant_currency : "uses"
    tenant_currency ||--o{ currency_rate : "dated rates"
    user ||--o{ recent_item : "viewed"
    user ||--o{ recycle_bin_item : "deleted"
    recycle_bin_item |o--o{ recycle_bin_item : "cascade of"

    field_history {
        uuid tenant_id PK
        timestamptz changed_at PK "monthly partitions (Q12)"
        uuid id PK
        text object
        uuid record_id
        text field
        jsonb old_value
        jsonb new_value
        uuid changed_by
    }
    recycle_bin_item {
        uuid tenant_id PK
        uuid id PK
        text object
        uuid record_id
        text name
        uuid deleted_by
        uuid cascade_of FK
        timestamptz purge_after "30 days"
    }
    recent_item {
        uuid tenant_id PK
        uuid user_id PK
        text object PK
        uuid record_id PK
        timestamptz viewed_at "latest 100 kept"
    }
    tenant_currency {
        uuid tenant_id PK
        char code PK "ISO 4217"
        boolean active
    }
    currency_rate {
        uuid tenant_id PK
        uuid id PK
        char code
        date effective_date "one per currency per day"
        numeric rate "units per corporate unit"
        int version
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
