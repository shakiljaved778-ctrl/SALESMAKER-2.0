import type { TenantTransaction } from '@sm/db';
import {
  checkFormula,
  evaluateFormula,
  metadataEnvironment,
  relationshipName,
  type TypedNode,
} from '@sm/formula';
import type { ObjectMeta } from '@sm/metadata';
import { sql } from 'kysely';

import type { RecordContext } from './context.js';
import type { FieldError } from './errors.js';
import { ident, readStored } from './storage.js';

/** Paths that reach another record (`account.name`), which must be loaded before evaluating. */
function crossObjectPaths(node: TypedNode, out = new Set<string>()): Set<string> {
  switch (node.kind) {
    case 'field':
      if (node.path.length > 1) out.add(node.path.join('.'));
      break;
    case 'unary':
      crossObjectPaths(node.operand, out);
      break;
    case 'binary':
      crossObjectPaths(node.left, out);
      crossObjectPaths(node.right, out);
      break;
    case 'call':
      for (const a of node.args) crossObjectPaths(a, out);
      break;
    default:
      break;
  }
  return out;
}

const PLATFORM_TABLES: Record<string, { table: string; fields: readonly string[] }> = {
  user: { table: 'user', fields: ['id', 'name', 'email', 'title', 'department', 'phone'] },
  queue: { table: 'queue', fields: ['id', 'name', 'email'] },
  record_type: { table: 'record_type', fields: ['id', 'name', 'api_name'] },
  pipeline: { table: 'pipeline', fields: ['id', 'name'] },
};

/**
 * The value at the end of a lookup path, read in system context (validation rules see related
 * records whatever the writer's access, as in Salesforce). Null when any hop is empty.
 */
async function relatedValue(
  tx: TenantTransaction,
  ctx: RecordContext,
  root: ObjectMeta,
  values: Record<string, unknown>,
  path: readonly string[],
): Promise<unknown> {
  let object: string = root.apiName;
  let current: Record<string, unknown> = values;
  for (let i = 0; i < path.length - 1; i += 1) {
    const meta = ctx.metadata.object(object);
    const lookup = meta?.fields.find(
      (f) =>
        ['lookup', 'master_detail', 'user'].includes(f.type) && relationshipName(f) === path[i],
    );
    if (!lookup) return null;
    const id = current[lookup.apiName];
    if (typeof id !== 'string') return null;
    const target = lookup.referenceTo[0] ?? 'user';
    const platform = PLATFORM_TABLES[target];
    if (platform) {
      const field = path[i + 1] ?? '';
      if (i + 1 !== path.length - 1 || !platform.fields.includes(field)) return null;
      const rows = await sql<{ v: unknown }>`
        SELECT ${sql.ref(ident(field))}::text AS v FROM ${sql.table(platform.table)}
        WHERE tenant_id = ${tx.context.tenantId}::uuid AND id = ${id}::uuid`.execute(tx.kysely);
      return rows.rows[0]?.v ?? null;
    }
    const targetMeta = ctx.metadata.object(target);
    if (!targetMeta) return null;
    const stored = await readStored(tx, targetMeta, id);
    if (!stored) return null;
    object = target;
    current = stored.values;
  }
  return current[path.at(-1) ?? ''] ?? null;
}

/**
 * Run the object's active validation rules against the record as it would be saved (§3.7 step 5).
 * A rule whose formula is true rejects the save with its own message; a rule that no longer type
 * checks, or fails at runtime, also rejects it (a broken rule never silently lets data through).
 */
export async function runValidationRules(
  tx: TenantTransaction,
  ctx: RecordContext,
  object: ObjectMeta,
  values: Record<string, unknown>,
  prior: Record<string, unknown> | null,
): Promise<FieldError[]> {
  const rules = object.validationRules.filter((r) => r.active);
  if (rules.length === 0) return [];
  const env = metadataEnvironment(ctx.metadata, object.apiName, { allowPriorValues: true });
  const errors: FieldError[] = [];
  const related = new Map<string, unknown>();
  for (const rule of rules) {
    const failure = (): FieldError => ({
      field: rule.errorField ?? '_record',
      code: 'validation_rule',
      message: rule.errorMessage,
    });
    const checked = checkFormula(rule.formula, env, 'Boolean');
    if (!checked.ok) {
      errors.push(failure());
      continue;
    }
    for (const path of crossObjectPaths(checked.ast))
      if (!related.has(path))
        related.set(path, await relatedValue(tx, ctx, object, values, path.split('.')));
    const result = evaluateFormula(checked.ast, {
      field: (p) => (p.length === 1 ? values[p[0] ?? ''] : related.get(p.join('.'))),
      prior: (p) => (prior ? prior[p[0] ?? ''] : undefined),
      isNew: prior === null,
      global: (scope, name) => ctx.globals(scope, name),
      now: ctx.now?.() ?? new Date(),
      timezone: ctx.timezone,
    });
    if (!result.ok || result.value === true) errors.push(failure());
  }
  return errors;
}
