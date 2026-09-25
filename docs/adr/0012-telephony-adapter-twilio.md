# ADR-0012: Telesales-grade telephony behind a CTI adapter (Twilio default)

- **Status:** Accepted (locked decision #11 in MASTER_SPEC §1.4)
- **Date:** 2026-09-25
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §7.8

## Context
Telesales floors need click-to-call, softphone, dialer queues, dispositions, agent states, wallboards and compliance.

## Decision
A `TelephonyProvider` interface with a default **Twilio Voice** WebRTC adapter, designed so Amazon Connect, Aircall, Genesys Cloud, 3CX and SIP can plug in later without touching feature code. Preview and progressive dialing only (no predictive dialing in v1). Dispositions map to actions. Agent states are event-logged. DNC, calling windows in the recipient's timezone, and per-country recording consent are enforced. Recordings stay at the provider (links plus metadata, with audited access).

## Consequences
+ Vendor flexibility, and a regulatory posture that avoids predictive dialing.
− WebRTC/VoIP rules in some GCC markets may require a local carrier or SIP adapter (see the open questions).

## Alternatives rejected
Building on raw SIP from day one (slow); a single-vendor lock-in with no adapter.

> Changing this decision requires the owner's approval (§0.3) and a new superseding ADR.
