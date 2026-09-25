# ADR-0017: Navigation: left sidebar + ⌘K palette + workspace record tabs

- **Status:** Accepted (locked decision #20 in MASTER_SPEC §1.4)
- **Date:** 2026-09-25
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §9.7, §9.11, §7.19

## Context
Telesales reps multitask across many records, and power users are keyboard-driven.

## Decision
A dark left sidebar (232 px, collapsible to 56) in both themes. A global ⌘K command palette for records, commands, recents and Ask AI. Up to 12 persistent **workspace tabs** for opened records. A top bar with search, +New, AI (⌘J), notifications and the avatar menu. The full keyboard map is in §9.11.

## Consequences
+ A fast multitasking loop.
− Tab-state persistence and memory management in the SPA need care.

## Alternatives rejected
Top-nav only (wastes vertical density); no tabs (breaks the telesales multitasking use case).

> Changing this decision requires the owner's approval (§0.3) and a new superseding ADR.
