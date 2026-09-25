# ADR-0013: Channels: Gmail/Outlook sync, WhatsApp Cloud API, SMS

- **Status:** Accepted (locked decision #12 in MASTER_SPEC §1.4)
- **Date:** 2026-09-25
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §7.9

## Context
Reps work across email, WhatsApp (dominant in GCC/India) and SMS.

## Decision
Per-user OAuth mailbox sync: Gmail API with Pub/Sub, and Microsoft Graph with change notifications. Only threads matched to known leads/contacts are stored, and sending goes through the user's mailbox. WhatsApp uses the Meta Cloud API via Embedded Signup, with templates outside the 24 h window and opt-in/opt-out tracked in `consent_record`. SMS goes through `SmsProvider` (Twilio default, with a regional slot such as Unifonic). All messages become `activity` rows. Every channel has fakes for CI.

## Consequences
+ Covers the channels that matter in target markets.
− External approvals have long lead times: Google restricted-scope verification (CASA), Microsoft publisher verification, Meta Tech Provider/Embedded Signup.

## Alternatives rejected
BCC-to-CRM email logging only (not two-way); WhatsApp via unofficial APIs (ToS and ban risk).

> Changing this decision requires the owner's approval (§0.3) and a new superseding ADR.
