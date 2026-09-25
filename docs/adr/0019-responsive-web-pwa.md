# ADR-0019: Responsive web + installable PWA in v1; native apps in v2

- **Status:** Accepted (locked decision #22 in MASTER_SPEC §1.4)
- **Date:** 2026-09-25
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §7.21, §9.9

## Context
Reps and managers need mobile access. Native apps would double the surface in v1.

## Decision
Responsive layouts per the §9.9 breakpoints (mobile bottom tab bar under `md`). P12 adds an installable PWA with offline read of the last 200 records plus today's tasks (encrypted IndexedDB, cleared on logout), an offline queue for tasks and notes, web push, and `tel:` click-to-call with a post-call log prompt. React Native/Expo comes in v2.

## Consequences
+ One codebase for v1.
− iOS PWA limits (push only on iOS 16.4+ installed PWAs; storage eviction).

## Alternatives rejected
Native apps in v1 (scope); desktop-only (loses field users).

> Changing this decision requires the owner's approval (§0.3) and a new superseding ADR.
