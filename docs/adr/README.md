# Architecture Decision Records

Format: MADR (Context · Decision · Consequences · Alternatives rejected). Each row of MASTER_SPEC §1.4
maps to at least one ADR. Rows that are facets of one decision share an ADR, as the spec's own example
`0002-turborepo-nextjs-nestjs` does. New decisions get the next free number. Superseded ADRs stay in place
and are marked `Superseded by ADR-xxxx`.

| ADR                                                 | Title                                                                      | §1.4 decision(s)     |
| --------------------------------------------------- | -------------------------------------------------------------------------- | -------------------- |
| [ADR-0001](0001-multi-tenant-shared-db-rls.md)      | Multi-tenant shared Postgres with forced row-level security                | #6 (and #3)          |
| [ADR-0002](0002-turborepo-nextjs-nestjs.md)         | Turborepo monorepo with Next.js web and NestJS API                         | #24                  |
| [ADR-0003](0003-hosting-vercel-aws.md)              | Hosting: Vercel for web, AWS for API and data                              | #25                  |
| [ADR-0004](0004-prisma-plus-kysely.md)              | Prisma for schema and migrations, Kysely for dynamic metadata SQL          | #24                  |
| [ADR-0005](0005-regional-cells-data-residency.md)   | Regional cells and per-tenant data residency                               | #26 (and #2)         |
| [ADR-0006](0006-in-house-auth.md)                   | In-house authentication                                                    | #27                  |
| [ADR-0007](0007-salesforce-style-permissions.md)    | Salesforce-style permission and sharing model                              | #31 (and #7)         |
| [ADR-0008](0008-audit-field-history-hash-chain.md)  | Field history plus an immutable, hash-chained audit log                    | #33                  |
| [ADR-0009](0009-flat-org-pricing-stripe.md)         | Flat per-organisation pricing on Stripe                                    | #4, #30 (and #3)     |
| [ADR-0010](0010-ai-provider-abstraction-claude.md)  | Claude behind a provider-abstraction AI gateway                            | #14 (and #13)        |
| [ADR-0011](0011-agentic-ai-approval-gates.md)       | Agentic AI with human approval gates                                       | #15                  |
| [ADR-0012](0012-telephony-adapter-twilio.md)        | Telesales-grade telephony behind a CTI adapter (Twilio default)            | #11                  |
| [ADR-0013](0013-channels-email-whatsapp-sms.md)     | Channels: Gmail/Outlook sync, WhatsApp Cloud API, SMS                      | #12                  |
| [ADR-0014](0014-public-api-rest-webhooks-oauth.md)  | Public API: REST + webhooks + OAuth connected apps                         | #28                  |
| [ADR-0015](0015-design-language-sdl.md)             | SalesMaker Design Language (SDL): reference, palette, themes, density      | #16, #17, #18, #23   |
| [ADR-0016](0016-ui-shadcn-radix-tailwind.md)        | UI stack: shadcn/ui + Radix + Tailwind v4 wrapped as @sm/ui                | #21                  |
| [ADR-0017](0017-navigation-sidebar-palette-tabs.md) | Navigation: left sidebar + ⌘K palette + workspace record tabs              | #20                  |
| [ADR-0018](0018-english-only-rtl-ready.md)          | English-only v1 with an RTL-ready architecture                             | #19                  |
| [ADR-0019](0019-responsive-web-pwa.md)              | Responsive web + installable PWA in v1; native apps in v2                  | #22                  |
| [ADR-0020](0020-horizontal-core-module-scope.md)    | Horizontal configurable core and v1 module scope                           | #5, #10              |
| [ADR-0021](0021-territory-management.md)            | Full Salesforce-style territory management                                 | #9                   |
| [ADR-0022](0022-scale-envelope.md)                  | Per-tenant scale envelope: 1,000 users · 5M leads · 50M activities         | #8                   |
| [ADR-0023](0023-compliance-posture.md)              | Compliance posture: SOC 2-ready, GDPR, Qatar PDPPL, UAE/KSA PDPL           | #32                  |
| [ADR-0024](0024-engineering-process.md)             | Engineering process: phased delivery, ADRs, test-first, one PR per feature | #29, #35, #36        |
| [ADR-0025](0025-demo-tenants.md)                    | Two seeded demo tenants                                                    | #37                  |
| [ADR-0026](0026-delivery-horizon.md)                | Delivery horizon: MVP in 8 weeks, full v1 by ~week 26                      | #34                  |
| [ADR-0027](0027-separate-from-wealthengine.md)      | SalesMaker is fully separate from WealthEngine                             | — (relationship row) |
| [ADR-0028](0028-naming-namespace.md)                | Name and code namespace                                                    | #1                   |
| [ADR-0029](0029-global-first.md)                    | Global from day one: currency, timezone, locale                            | #2                   |

Every §1.4 row is covered: #1→0028 · #2→0029/0005 · #3→0001/0009 · #4→0009 · #5→0020 · #6→0001 · #7→0007 ·
#8→0022 · #9→0021 · #10→0020 · #11→0012 · #12→0013 · #13→0010 · #14→0010 · #15→0011 · #16–18→0015 ·
#19→0018 · #20→0017 · #21→0016 · #22→0019 · #23→0015 · #24→0002/0004 · #25→0003 · #26→0005 · #27→0006 ·
#28→0014 · #29→0024 · #30→0009 · #31→0007 · #32→0023 · #33→0008 · #34→0026 · #35–36→0024 · #37→0025 ·
WealthEngine→0027.
