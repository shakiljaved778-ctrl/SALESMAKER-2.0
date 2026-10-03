# Search

Spec: §7.19, §3.8, §6.5 · Code: `packages/query-engine/src/search.ts`, migration `0020_search`,
`apps/api/src/records` (`GET /v1/search`, recent items), `apps/web/src/components/records/search-*.tsx`,
`apps/web/src/components/shell/command-menu.tsx`

Global search over leads, accounts, contacts, opportunities and campaigns, in Postgres. `search()` is the one
entry point, so an OpenSearch provider (P12) can replace it without touching callers.

## Index

- **`search_vector`**, maintained by trigger on every write, weighted A (names, e-mail words, phone digits), B
  (company, or title and department), C (other text). GIN indexes lead with `tenant_id` (`btree_gin`) and skip
  deleted rows. `SEARCH_FIELDS` mirrors the trigger; a test proves both build identical vectors.
- **Typos:** `pg_trgm` word-similarity GIN indexes on the name expression.
- **Phones:** E.164 values plus `crm_phone_rev()` reversed-digit indexes, so 4+ trailing digits find a number.

## Query

`search()` runs an exact pass per object: prefix full text (`to_tsquery` with `:*`) and phone suffixes, ranked with
`ts_rank`, with the sharing predicate in SQL; display values come through SMQ, so sharing and FLS apply twice. Only
when nothing matched exactly in any object does it run the typo pass (`pg_trgm` word similarity on names), the
"did you mean" fallback of plan §3.5.

**FLS.** A field the caller cannot read never decides a match: the readable part of the vector is rechecked,
trigram matching is off when a name field is hidden, hidden phones are not suffix-matched, and hidden fields are
never reported in `matched`.

## API and UI

`GET /v1/search?q=&objects=&limit=&ownerId=&updatedSince=&totals=` returns results grouped by object (totals
capped at 100 for the facets). `POST /v1/records/{object}/{id}/viewed` and `GET /v1/recent-items` keep and list a
user's latest 100 records (only those still visible). ⌘K shows matching records, recent items, navigation and
commands, with "See all results" last; `/search` has object, owner and updated filters.

## Performance

At 500k leads exact searches meet the budget (p95 126–187 ms for an agent and an administrator). Under row-level
security the GIN indexes cannot drive a scan (the operators are not leakproof), so search scans the tenant's rows
in parallel and grows linearly; typo-only searches take ~350 ms for an agent and ~1.2 s for an administrator. The
fix needs an owner decision (OPEN_QUESTIONS Q31). Details in [P02-notes](../phases/P02-notes.md) (T28).

## Tests

`packages/query-engine/test/search.test.ts` (ranking, typos, phone suffixes, FLS, sharing), `apps/api/test/search-api.test.ts`,
and the search steps of `apps/web/e2e/records.spec.ts`.
