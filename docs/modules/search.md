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

`search()` matches prefix full text (`to_tsquery` with `:*`), trigram names and phone suffixes, ranks with
`ts_rank` (trigram similarity as fallback), applies the sharing predicate in SQL, and loads display values through
SMQ, so sharing and FLS apply twice.

**FLS.** A field the caller cannot read never decides a match: the readable part of the vector is rechecked,
trigram matching is off when a name field is hidden, hidden phones are not suffix-matched, and hidden fields are
never reported in `matched`.

## API and UI

`GET /v1/search?q=&objects=&limit=&ownerId=&updatedSince=&totals=` returns results grouped by object (totals
capped at 100 for the facets). `POST /v1/records/{object}/{id}/viewed` and `GET /v1/recent-items` keep and list a
user's latest 100 records (only those still visible). ⌘K shows matching records, recent items, navigation and
commands, with "See all results" last; `/search` has object, owner and updated filters.

## Performance

Measured at 500k leads in T28 (budget: p95 ≤ 200 ms API); numbers in [P02-notes](../phases/P02-notes.md).

## Tests

`packages/query-engine/test/search.test.ts` (ranking, typos, phone suffixes, FLS, sharing), `apps/api/test/search-api.test.ts`,
and the search steps of `apps/web/e2e/records.spec.ts`.
