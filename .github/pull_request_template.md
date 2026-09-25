## Summary

<!-- What changed and why, in two or three sentences. -->

## Linked phase task

<!-- e.g. P00 · T05 — docs/phases/P00-tasks.md -->

## Screenshots (UI changes: light + dark)

## Test evidence

<!-- Commands run and results; new tests added. -->

## Migration notes

<!-- Expand/contract step, if any. "None" otherwise. -->

## Security / permissions impact

<!-- Tenancy, RLS, sharing, FLS, auth, secrets. "None" otherwise. -->

## Checklist

- [ ] Design tokens only (no raw hex, px font sizes or ad-hoc shadows)
- [ ] All user-facing copy via i18n keys
- [ ] Logical CSS only
- [ ] FLS applied where data is shown or written
- [ ] Cross-tenant denial test for every touched endpoint
- [ ] Docs updated (ADR / docs/modules / OpenAPI descriptions)
- [ ] `pnpm verify` green
