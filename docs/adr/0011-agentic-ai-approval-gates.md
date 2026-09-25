# ADR-0011: Agentic AI with human approval gates

- **Status:** Accepted (locked decision #15 in MASTER_SPEC §1.4)
- **Date:** 2026-09-25
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §8.10

## Context
Agents can create real value, and real risk, especially around external communications.

## Decision
Agents are admin-defined and off by default. Each has a run-as integration user, a scope, an allow-listed toolset, a policy per action type (`AUTO | REQUIRE_APPROVAL | FORBIDDEN`), budgets and approvers. External communications default to `REQUIRE_APPROVAL` and can only become `AUTO` through an explicit admin opt-in with a warning. Proposals land in the approval inbox with diff, rationale, confidence and sources. Every run is logged in `ai_agent_run`, and executed actions are audited as `agent:{id} on behalf of {user}`. There is a kill switch per agent and a tenant-wide one.

## Consequences
+ Safe by default, explainable and reversible.
− Approval-inbox UX quality decides adoption.

## Alternatives rejected
Fully autonomous agents (unacceptable risk); suggestions only, with no execution (too little value).

> Changing this decision requires the owner's approval (§0.3) and a new superseding ADR.
