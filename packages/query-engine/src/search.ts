import type { ObjectMeta } from '@sm/metadata';
import { fieldAccess, objectAccess } from '@sm/permissions';
import { sql, type Kysely, type RawBuilder } from 'kysely';

import { sharingPredicate } from './sharing-predicate.js';
import { runQuery, type QueryContext, type QueryRecord } from './smq.js';

/*
 * Search v1 (§7.19): Postgres full text over a weighted vector (A names, email, phones; B company
 * or title; C other text), pg_trgm word similarity on names for typos, and phone suffixes. The
 * field lists below mirror the trigger and indexes of migration 0020; a field the caller cannot
 * read is never matched on and never reported as matched (FLS, §6.5), and every hit passes the
 * sharing predicate. A SearchProvider for OpenSearch can replace this later (P12).
 */

type Kind = 'words' | 'phone';
interface SearchSpec {
  /** Fields in the search vector, by weight, as the trigger builds it. */
  vector: readonly (readonly [field: string, weight: 'A' | 'B' | 'C', kind: Kind])[];
  /** The trigram index expression's fields, joined by spaces. */
  trigram: readonly string[];
  /** Fields with a reversed-digit phone index. */
  phones: readonly string[];
}

export const SEARCH_FIELDS: Readonly<Record<string, SearchSpec>> = {
  lead: {
    vector: [
      ['first_name', 'A', 'words'],
      ['last_name', 'A', 'words'],
      ['email', 'A', 'words'],
      ['phone', 'A', 'phone'],
      ['mobile_phone', 'A', 'phone'],
      ['company', 'B', 'words'],
      ['title', 'C', 'words'],
      ['city', 'C', 'words'],
      ['website', 'C', 'words'],
    ],
    trigram: ['first_name', 'last_name', 'company'],
    phones: ['phone', 'mobile_phone'],
  },
  contact: {
    vector: [
      ['first_name', 'A', 'words'],
      ['last_name', 'A', 'words'],
      ['email', 'A', 'words'],
      ['phone', 'A', 'phone'],
      ['mobile_phone', 'A', 'phone'],
      ['title', 'B', 'words'],
      ['department', 'B', 'words'],
      ['mailing_city', 'C', 'words'],
    ],
    trigram: ['first_name', 'last_name'],
    phones: ['phone', 'mobile_phone'],
  },
  account: {
    vector: [
      ['name', 'A', 'words'],
      ['phone', 'A', 'phone'],
      ['website', 'A', 'words'],
      ['billing_city', 'C', 'words'],
    ],
    trigram: ['name'],
    phones: ['phone'],
  },
  opportunity: {
    vector: [
      ['name', 'A', 'words'],
      ['next_step', 'C', 'words'],
    ],
    trigram: ['name'],
    phones: [],
  },
  campaign: { vector: [['name', 'A', 'words']], trigram: ['name'], phones: [] },
};

export interface SearchInput {
  q: string;
  /** Objects to search (default: every searchable object the caller can read). */
  objects?: readonly string[];
  /** Results per object (palette: 5; results page: up to 50). */
  limit?: number;
  ownerId?: string;
  /** Only records changed on or after this instant. */
  updatedSince?: Date;
  /** Count matches per object (capped), for the results page's facets. */
  withTotals?: boolean;
}

export interface SearchHit {
  id: string;
  /** The record's display name, from its readable name fields. */
  name: string | null;
  /** Readable fields the query matched in (for highlighting). */
  matched: string[];
  /** Display fields (readable compact fields) as the Query Engine returns them. */
  record: QueryRecord;
}

export interface SearchGroup {
  object: string;
  hits: SearchHit[];
  /** Matches, capped at TOTAL_CAP (present with `withTotals`). */
  total?: number;
}

export const TOTAL_CAP = 100;
const MAX_TOKENS = 8;

/** Query words, lower-cased letters and digits only: safe to splice into a tsquery string. */
export function searchTokens(q: string): string[] {
  return (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_TOKENS);
}

const col = (field: string) => sql.ref(`r.${field}`);
const piece = (field: string, kind: Kind) =>
  kind === 'phone' ? sql`crm_search_phone(${col(field)})` : sql`crm_search_words(${col(field)})`;

function trigramExpr(fields: readonly string[]): RawBuilder<unknown> {
  // Must equal the index expression of migration 0020 to use the index.
  if (fields.length === 1) return col(fields[0] ?? 'name');
  return sql.join(
    fields.map((f) => sql`coalesce(${col(f)}, '')`),
    sql` || ' ' || `,
  );
}

/** The display fields for a hit: readable name fields, then up to three readable compact fields. */
function displayFields(ctx: QueryContext, object: ObjectMeta): string[] {
  const readable = (name: string) => {
    const f = object.fields.find((x) => x.apiName === name);
    return f ? fieldAccess(ctx.permissions, object.apiName, name, f).read : false;
  };
  const names = ctx.metadata.nameFields(object.apiName).filter(readable);
  const compact = object.compactFields.filter((f) => readable(f) && !names.includes(f)).slice(0, 3);
  return [...names, ...compact];
}

/** Search one object; null when the caller cannot search it. */
async function searchObject<DB>(
  db: Kysely<DB>,
  ctx: QueryContext,
  object: ObjectMeta,
  spec: SearchSpec,
  input: SearchInput,
  tokens: string[],
): Promise<SearchGroup> {
  const readable = (name: string) => {
    const f = object.fields.find((x) => x.apiName === name);
    return f ? fieldAccess(ctx.permissions, object.apiName, name, f).read : false;
  };
  const tsq = sql`to_tsquery('simple', ${tokens.map((t) => `${t}:*`).join(' & ')})`;
  const vectorFields = spec.vector.filter(([f]) => readable(f));
  const paths: RawBuilder<unknown>[] = [];
  const scores: RawBuilder<unknown>[] = [];
  const matched: RawBuilder<unknown>[] = [];
  if (tokens.length && vectorFields.length) {
    // The stored vector finds candidates by index; when some of its fields are hidden from the
    // caller, the readable part alone must match too.
    const recheck =
      vectorFields.length < spec.vector.length
        ? sql` AND (${sql.join(
            vectorFields.map(([f, , k]) => piece(f, k)),
            sql` || `,
          )}) @@ ${tsq}`
        : sql``;
    paths.push(sql`(r.search_vector @@ ${tsq}${recheck})`);
    scores.push(sql`ts_rank(r.search_vector, ${tsq})`);
    for (const [f, , k] of vectorFields)
      matched.push(sql`CASE WHEN ${piece(f, k)} @@ ${tsq} THEN ${f} END`);
  }
  const q = input.q.trim();
  if (q.length >= 3 && spec.trigram.length && spec.trigram.every(readable)) {
    const expr = trigramExpr(spec.trigram);
    paths.push(sql`(${q} <% (${expr}))`);
    scores.push(sql`word_similarity(${q}, ${expr})`);
    for (const f of spec.trigram)
      matched.push(sql`CASE WHEN ${q} <% coalesce(${col(f)}, '') THEN ${f} END`);
  }
  const digits = q.replace(/\D/g, '');
  if (digits.length >= 4) {
    const suffix = `${Array.from(digits).reverse().join('')}%`;
    for (const f of spec.phones.filter(readable)) {
      const hit = sql`crm_phone_rev(${col(f)}) LIKE ${suffix}`;
      paths.push(sql`(${hit})`);
      scores.push(sql`CASE WHEN ${hit} THEN 1 ELSE 0 END`);
      matched.push(sql`CASE WHEN ${hit} THEN ${f} END`);
    }
  }
  if (paths.length === 0) return { object: object.apiName, hits: [] };

  const where = sql.join(
    [
      sql`r.tenant_id = ${ctx.sharing.tenantId}::uuid`,
      sql`r.deleted_at IS NULL`,
      sql`(${sql.join(paths, sql` OR `)})`,
      ...(input.ownerId ? [sql`r.owner_id = ${input.ownerId}::uuid`] : []),
      ...(input.updatedSince
        ? [sql`r.updated_at >= ${input.updatedSince.toISOString()}::timestamptz`]
        : []),
      sql`${sharingPredicate(ctx.sharing, object.apiName, 'r', 'read')}`,
    ],
    sql` AND `,
  );
  const table = sql.table(object.table);
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 50);
  const rows = await sql<{ id: string; matched: (string | null)[] }>`
    SELECT r.id, ARRAY[${sql.join(matched)}]::text[] AS matched
      FROM ${table} AS r
     WHERE ${where}
     ORDER BY (${sql.join(scores, sql` + `)}) DESC, r.updated_at DESC, r.id
     LIMIT ${limit}`.execute(db);
  const ids = rows.rows.map((r) => r.id);
  let total: number | undefined;
  if (input.withTotals) {
    const counted = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM (SELECT 1 FROM ${table} AS r WHERE ${where} LIMIT ${TOTAL_CAP}) s`.execute(
      db,
    );
    total = counted.rows[0]?.n ?? 0;
  }
  if (ids.length === 0)
    return { object: object.apiName, hits: [], ...(total !== undefined ? { total } : {}) };

  // Display values through the Query Engine: sharing again, and FLS on every field.
  const fields = displayFields(ctx, object);
  const page = await runQuery(
    db,
    {
      object: object.apiName,
      fields: fields.length ? fields : ['id'],
      where: { field: 'id', op: 'in', value: ids },
      limit: ids.length,
    },
    { ...ctx, maxLimit: Math.max(ctx.maxLimit, ids.length) },
  );
  const byId = new Map(page.records.map((r) => [r.id, r]));
  const names = ctx.metadata.nameFields(object.apiName);
  const hits: SearchHit[] = [];
  for (const row of rows.rows) {
    const record = byId.get(row.id);
    if (!record) continue;
    const name = names
      .map((n) => record[n])
      .filter((v): v is string => typeof v === 'string' && v !== '')
      .join(' ');
    hits.push({
      id: row.id,
      name: name || null,
      matched: [...new Set(row.matched.filter((m): m is string => m !== null))],
      record,
    });
  }
  return { object: object.apiName, hits, ...(total !== undefined ? { total } : {}) };
}

/** Search records across objects for the caller (§7.19), grouped by object. */
export async function search<DB>(
  db: Kysely<DB>,
  ctx: QueryContext,
  input: SearchInput,
): Promise<SearchGroup[]> {
  const tokens = searchTokens(input.q);
  if (tokens.length === 0 && input.q.replace(/\D/g, '').length < 4) return [];
  const wanted = input.objects ?? Object.keys(SEARCH_FIELDS);
  const groups: SearchGroup[] = [];
  for (const name of wanted) {
    const spec = SEARCH_FIELDS[name];
    const object = ctx.metadata.object(name);
    if (!spec || !object || object.features['search'] === false) continue;
    if (!objectAccess(ctx.permissions, name).read) continue;
    groups.push(await searchObject(db, ctx, object, spec, input, tokens));
  }
  return groups;
}

/** Remember that the caller opened a record (recent items, §7.19); keeps the latest 100. */
export async function recordViewed<DB>(
  db: Kysely<DB>,
  ctx: QueryContext,
  object: string,
  id: string,
): Promise<boolean> {
  const meta = ctx.metadata.object(object);
  if (!meta || !objectAccess(ctx.permissions, object).read) return false;
  const visible = await sql`SELECT 1 FROM ${sql.table(meta.table)} AS r
    WHERE r.tenant_id = ${ctx.sharing.tenantId}::uuid AND r.id = ${id}::uuid AND r.deleted_at IS NULL
      AND ${sharingPredicate(ctx.sharing, object, 'r', 'read')}`.execute(db);
  if (visible.rows.length === 0) return false;
  const tenantId = ctx.sharing.tenantId;
  await sql`INSERT INTO recent_item (tenant_id, user_id, object, record_id, viewed_at)
    VALUES (${tenantId}::uuid, ${ctx.userId}::uuid, ${object}, ${id}::uuid, now())
    ON CONFLICT (tenant_id, user_id, object, record_id) DO UPDATE SET viewed_at = now()`.execute(
    db,
  );
  await sql`DELETE FROM recent_item WHERE tenant_id = ${tenantId}::uuid AND user_id = ${ctx.userId}::uuid
    AND (object, record_id) NOT IN (
      SELECT object, record_id FROM recent_item
       WHERE tenant_id = ${tenantId}::uuid AND user_id = ${ctx.userId}::uuid
       ORDER BY viewed_at DESC LIMIT 100)`.execute(db);
  return true;
}

/** The caller's recently viewed records they can still see, latest first. */
export async function recentItems<DB>(
  db: Kysely<DB>,
  ctx: QueryContext,
  limit = 20,
): Promise<(SearchHit & { object: string; viewedAt: string })[]> {
  const rows = await sql<{ object: string; record_id: string; viewed_at: string }>`
    SELECT object, record_id::text, to_char(viewed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS viewed_at
      FROM recent_item
     WHERE tenant_id = ${ctx.sharing.tenantId}::uuid AND user_id = ${ctx.userId}::uuid
     ORDER BY viewed_at DESC LIMIT ${Math.min(Math.max(limit, 1), 100)}`.execute(db);
  const byObject = new Map<string, string[]>();
  for (const r of rows.rows)
    byObject.set(r.object, [...(byObject.get(r.object) ?? []), r.record_id]);
  const found = new Map<string, QueryRecord>();
  for (const [object, ids] of byObject) {
    const meta = ctx.metadata.object(object);
    if (!meta || !objectAccess(ctx.permissions, object).read) continue;
    const fields = displayFields(ctx, meta);
    const page = await runQuery(
      db,
      {
        object,
        fields: fields.length ? fields : ['id'],
        where: { field: 'id', op: 'in', value: ids },
        limit: ids.length,
      },
      { ...ctx, maxLimit: Math.max(ctx.maxLimit, ids.length) },
    );
    for (const r of page.records) found.set(`${object}:${r.id}`, r);
  }
  return rows.rows.flatMap((r) => {
    const record = found.get(`${r.object}:${r.record_id}`);
    if (!record) return [];
    const name = ctx.metadata
      .nameFields(r.object)
      .map((n) => record[n])
      .filter((v): v is string => typeof v === 'string' && v !== '')
      .join(' ');
    return [
      {
        object: r.object,
        id: r.record_id,
        name: name || null,
        matched: [],
        record,
        viewedAt: r.viewed_at,
      },
    ];
  });
}
