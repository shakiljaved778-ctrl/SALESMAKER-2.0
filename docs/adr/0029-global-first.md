# ADR-0029: Global from day one: currency, timezone, locale

- **Status:** Accepted (locked decision #2 in MASTER_SPEC §1.4)
- **Date:** 2026-09-25
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §1.2, §0.4, §4.1

## Context
Target customers span the US, EU, GCC and India.

## Decision
Multi-currency with a corporate currency per tenant and dated `currency_rate` (every money column is paired with `currency_code`, plus `amount_corporate`). Timestamps are UTC `timestamptz`, and business dates use `date`. User timezone and locale drive presentation through `Intl`. Custom fiscal years and business hours/holidays per tenant. The UI is English-only in v1 (ADR-0018). Residency is covered in ADR-0005.

## Consequences
+ No retrofits needed for international customers.
− The conversion-date rules for reporting need definition (see the open questions).

## Alternatives rejected
Single-currency MVP (breaks the GCC/QAR demo tenant).

> Changing this decision requires the owner's approval (§0.3) and a new superseding ADR.
