# ADR-0003: Hosting: Vercel for web, AWS for API and data

- **Status:** Accepted (locked decision #25 in MASTER_SPEC §1.4)
- **Date:** 2026-09-25
- **Deciders:** Shakil Javed (owner)
- **Spec references:** §3.1, §13.5, §11.3

## Context
The web tier benefits from a global edge. The API and data must be regional for residency.

## Decision
Production runs `apps/web` on **Vercel**. API, workers, realtime, RDS PostgreSQL (Multi-AZ + read replica), ElastiCache Redis, S3, and optionally OpenSearch run on **AWS** per cell, deployed with ECS rolling deploys and provisioned with Terraform. Railway is allowed for staging. Deploys use GitHub Actions (staging on merge to main; prod on a `v*` tag with manual approval, canary cell first).

## Consequences
+ Best-in-class Next.js hosting, and AWS regional coverage for GCC (me-central-1).
− Two platforms to operate and secure.
− Vercel serves globally, so it must never hold tenant data at rest (the BFF stays stateless).

## Alternatives rejected
All-AWS (Amplify/CloudFront for Next.js: weaker DX); all-Vercel (no regional data plane); Kubernetes (ops overhead unjustified at launch).

> Changing this decision requires the owner's approval (§0.3) and a new superseding ADR.
