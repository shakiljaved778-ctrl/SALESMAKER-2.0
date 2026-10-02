# ADR-0031: Corporate-currency conversion with dated rates

- **Status:** Accepted (Q13, owner approval of the P02 plan, CHANGELOG_SPEC v1.4)
- **Date:** 2026-09-27
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §0.4 rule 8, §4.1, §4.5, §7.12, ADR-0029

## Context

Records hold money in their own currency (`numeric(18,2)` plus an ISO-4217 code). Pipeline totals, forecasts and
reports need one currency: the organisation's corporate currency. Rates move, so the question is which day's rate a
record uses, and what happens when a rate is corrected.

## Decision

- Each organisation keeps **active currencies** and **dated rates** (units of the currency per one corporate unit,
  positive, up to 8 places, one per currency per day). The corporate currency is always active and has no rates.
- **Opportunity `amount`** converts at the rate in force on its **close date**, recomputed when the close date,
  amount or currency changes. **Other money** converts at the rate in force on the **day the value is set**.
- A missing rate falls back to the latest earlier rate; the record stores which rate date was used.
- Each money object stores `<field>_corporate` (`numeric(18,2)`, half-up) and `corporate_rate_date`, written by
  RecordService through the tenant's converter. Arithmetic is Decimal only.
- Adding, changing or deleting a rate queues `maintenance.currency_recalc`, which rewrites only the amounts that rate
  governs, in batches of 1,000, without bumping versions or writing history (the rate change itself is audited).
- Deactivating a currency keeps it on existing records and refuses it on new writes.

## Consequences

- Closed-won amounts in reports reflect the rate at close, matching Salesforce advanced currency management.
- A rate inserted between two existing dates cannot re-rate non-opportunity money set in that window, because the
  day a value was set is not stored, only the rate date it used.
- Campaign money shares one `corporate_rate_date` across its three fields; the last conversion's date wins.

## Alternatives rejected

Converting at today's rate on every read (reports would shift daily, and sorting and filtering on corporate amounts
would be impossible in SQL); one static rate per currency (no history); converting everything at create date
(pipeline value would ignore the expected close).
