# P01 working notes (input for the handoff)

Deviations from the plan or spec, calls the spec leaves open, and follow-ups, recorded as they happen.

## Decisions the spec leaves open

- **Web coverage gate (T01).** The unit gate covers the BFF (`apps/web/src/server`), which owns cookies, CSRF,
  tenant resolution and OIDC state. Pages, components and the browser session code are covered by the e2e journeys.
- **Sharing defaults for Quote, Contract and Order (T02).** §6.3 names defaults for seven objects only. Quote is
  `CONTROLLED_BY_PARENT` (master-detail to its opportunity, the only model allowed); Contract and Order are `PRIVATE`.
- **Object chip colours (T02).** §9.9 gives colours for Lead, Account, Contact, Opportunity, Campaign, Quote, Order
  and Task (Activity). Product and Contract are not listed and use graphite. Iris is never used: it means AI.
- **Object icons (T02).** §9.9 fixes one Lucide icon per object without naming them: `user-round-plus` (Lead),
  `building-2` (Account), `contact-round` (Contact), `target` (Opportunity), `megaphone` (Campaign), `package`
  (Product), `file-text` (Quote), `file-signature` (Contract), `shopping-cart` (Order), `list-checks` (Activity).
- **Standard field API names (T02)** are snake_case and equal the column names; lookups end in `_id`. Labels live in
  `@sm/i18n` under `objects.<object>.fields.<camelCase>`, with the §4.1 columns shared under `objects.common`.
- **Field-level security scope (T02).** System fields (ids, audit stamps, conversion links, roll-ups) and required
  fields are outside FLS: system fields are always readable and never editable, and required fields stay editable so
  records can be saved (Salesforce behaves the same way).
