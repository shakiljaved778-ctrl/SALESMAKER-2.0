# Leads

Spec: §4.3, §4.4 · Code: `packages/records/src/convert.ts`, `apps/api/src/records/leads.controller.ts`,
`apps/web/src/components/records/convert-dialog.tsx`

## Lifecycle

Lead statuses are admin-configurable picklist values, each mapped to a system category (§4.3); reports, AI and
routing use the category. The CONVERTED status is set only by conversion, and a converted lead is read-only (409
`record_locked`) except to the conversion itself.

## Conversion (§4.4)

`POST /v1/leads/{id}/convert` turns a lead into an account, a contact and optionally an opportunity, in **one
transaction**, every record through RecordService as the caller (permissions, FLS, validation rules, history and
audit apply; any failure rolls everything back).

- **Account and contact:** an existing record the caller can see, or a new one built from the field mapping and
  overridden by the request. An existing contact must belong to that account or to none.
- **Opportunity:** optional; named after the company by default; pipeline and stage from its record type; the
  contact becomes its primary contact role.
- **Field mapping:** defaults (company → account name, address → billing/mailing, person fields → contact,
  source and campaign → opportunity), overridable per target field by admins through
  `/v1/leads/field-mapping` (type-checked, audited). Only fields the caller can read on the lead and edit on the
  target are copied.
- **The lead** takes the CONVERTED status and the `converted_*` fields; campaign memberships are copied to the
  contact.
- **Undo** (`…/convert/undo`) within 24 h, by whoever converted or `modify_all_data`, when every record still has
  the version the conversion left: created records are removed for good, the lead's status comes back.

## UI

The record page's Convert action opens a dialog: create a new account (an exact name match is offered first) or
use an existing one, the new contact, an optional opportunity (name and close date, default in 30 days) and the
converted status. A toast offers Undo.

## Tests

`packages/records/test/convert.test.ts`, `apps/api/test/leads-api.test.ts`, and the conversion step of
`apps/web/e2e/records.spec.ts`.
