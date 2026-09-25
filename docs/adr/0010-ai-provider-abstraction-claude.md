# ADR-0010: Claude behind a provider-abstraction AI gateway

- **Status:** Accepted (locked decision #14 (and #13) in MASTER_SPEC §1.4)
- **Date:** 2026-09-25
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §8.1–§8.2

## Context
AI is native across the product. The owner chose Anthropic Claude and wants the provider to be swappable.

## Decision
The `@sm/ai` `AIGateway` exposes `complete/stream/structured/toolLoop/embed/transcribe` over the `LLMProvider`, `EmbeddingProvider` and `SpeechProvider` interfaces. Defaults are Anthropic Claude (tiered model IDs from env: FAST/SMART/DEEP, never hard-coded), Voyage embeddings and Deepgram speech-to-text. Prompts are versioned in `packages/ai/prompts` and logged as `prompt_id@version`. Every structured output is zod-validated with one retry. Usage is metered in `ai_usage_event` and counted against plan credits. Context builders query **as the user** through the Query Engine. Third-party text is wrapped as untrusted data. **LLM output is never executed as SQL or code.**

## Consequences
+ Swappable providers, auditable prompts, and cost control.
− Regional endpoint availability per cell must be verified for residency.
− An eval suite (≥ 200 golden cases) is a P07 gate.

## Alternatives rejected
Direct SDK calls scattered through features; a generic multi-provider framework (heavy, and leaks abstractions).

> Changing this decision requires the owner's approval (§0.3) and a new superseding ADR.
