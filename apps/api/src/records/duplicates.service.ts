import { Injectable } from '@nestjs/common';
import type { DuplicateCheckResult, DuplicateGroupDto } from '@sm/contracts';
import type { TenantTransaction } from '@sm/db';
import type { ObjectMeta } from '@sm/metadata';
import { fieldAccess, objectAccess } from '@sm/permissions';
import { runQuery } from '@sm/query-engine';
import {
  duplicateRules,
  findMatches,
  hasAccess,
  readStored,
  RecordError,
  ruleReadable,
  type DuplicateMatch,
  type MatchingRuleDefinition,
  type RecordContext,
} from '@sm/records';
import type { z } from 'zod';

type Group = z.infer<typeof DuplicateGroupDto>;
type Match = Group['matches'][number];

/**
 * Duplicate checks outside a save (§7.2): the live panel while typing, a record's potential
 * duplicates and the Setup preview. Only rules whose compared fields the caller can read are
 * run, and only records the caller can see are named (sharing and FLS, §6.4–6.5).
 */
@Injectable()
export class DuplicatesService {
  objectFor(ctx: RecordContext, name: string): ObjectMeta {
    const object = ctx.metadata.object(name);
    if (!object || !objectAccess(ctx.permissions, name).read) throw new RecordError('not_found');
    return object;
  }

  /** Values the caller typed, keeping only fields they can read. */
  readableValues(ctx: RecordContext, object: ObjectMeta, fields: Record<string, unknown>) {
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(fields)) {
      const f = object.fields.find((x) => x.apiName === name);
      if (f && fieldAccess(ctx.permissions, object.apiName, name, f).read) out[name] = value;
    }
    return out;
  }

  /** A record the caller can see, as stored. */
  async visibleValues(tx: TenantTransaction, ctx: RecordContext, object: ObjectMeta, id: string) {
    if (!(await hasAccess(tx, ctx, object, id, 'read'))) throw new RecordError('not_found');
    const stored = await readStored(tx, object, id);
    if (!stored) throw new RecordError('not_found');
    return stored.values;
  }

  /** Visible matches with their names, through the Query Engine (sharing and FLS again). */
  async named(
    tx: TenantTransaction,
    ctx: RecordContext,
    object: ObjectMeta,
    matches: readonly DuplicateMatch[],
  ): Promise<Match[]> {
    const visible = matches.filter(
      (m): m is DuplicateMatch & { id: string } => m.visible && !!m.id,
    );
    if (visible.length === 0) return [];
    const nameField = object.nameField;
    const readable = fieldAccess(
      ctx.permissions,
      object.apiName,
      nameField,
      object.fields.find((f) => f.apiName === nameField),
    ).read;
    const page = await runQuery(
      tx.kysely,
      {
        object: object.apiName,
        fields: readable ? ['id', nameField] : ['id'],
        where: { field: 'id', op: 'in', value: visible.map((m) => m.id) },
        limit: visible.length,
      },
      { ...ctx, maxLimit: 50 },
    );
    const names = new Map(
      page.records.map((r) => [r.id, readable ? ((r[nameField] as string | null) ?? null) : null]),
    );
    return visible
      .filter((m) => names.has(m.id))
      .map((m) => ({ id: m.id, name: names.get(m.id) ?? null, score: m.score }));
  }

  async matchesFor(
    tx: TenantTransaction,
    ctx: RecordContext,
    object: ObjectMeta,
    rule: MatchingRuleDefinition,
    values: Record<string, unknown>,
    selfId: string | null,
  ) {
    const found = await findMatches(tx, ctx, object, rule, [{ index: 0, id: selfId, values }]);
    return found.get(0) ?? [];
  }

  /** The panel while typing: what each applicable duplicate rule finds, and whether a save is blocked. */
  async check(
    tx: TenantTransaction,
    ctx: RecordContext,
    objectName: string,
    input: { fields: Record<string, unknown>; id?: string | undefined },
  ): Promise<z.infer<typeof DuplicateCheckResult>> {
    const object = this.objectFor(ctx, objectName);
    const typed = this.readableValues(ctx, object, input.fields);
    const values = input.id
      ? { ...(await this.visibleValues(tx, ctx, object, input.id)), ...typed }
      : typed;
    const rules = (await duplicateRules(tx, ctx, object.apiName)).filter((r) =>
      input.id ? r.onEdit : r.onCreate,
    );
    const profile = rules.some((r) => r.bypassProfileIds.length)
      ? ((
          await tx.prisma.user.findUnique({
            where: { tenantId_id: { tenantId: tx.context.tenantId, id: ctx.userId } },
            select: { profileId: true },
          })
        )?.profileId ?? null)
      : null;
    let blocked = false;
    const groups: Group[] = [];
    for (const rule of rules) {
      const matches = await this.matchesFor(
        tx,
        ctx,
        object,
        rule.matchingRule,
        values,
        input.id ?? null,
      );
      if (matches.length === 0) continue;
      if (rule.action === 'BLOCK' && !(profile && rule.bypassProfileIds.includes(profile)))
        blocked = true;
      if (!ruleReadable(ctx, object, rule.matchingRule)) continue;
      const named = await this.named(tx, ctx, object, matches);
      if (named.length)
        groups.push({ ruleId: rule.id, rule: rule.name, action: rule.action, matches: named });
    }
    return { blocked, groups };
  }

  /** A stored record's potential duplicates under the active duplicate rules. */
  async potential(
    tx: TenantTransaction,
    ctx: RecordContext,
    objectName: string,
    id: string,
  ): Promise<{ groups: Group[] }> {
    const object = this.objectFor(ctx, objectName);
    const values = await this.visibleValues(tx, ctx, object, id);
    const groups: Group[] = [];
    const seen = new Set<string>();
    for (const rule of await duplicateRules(tx, ctx, object.apiName)) {
      // Rules sharing a matching rule find the same records: list them once.
      if (seen.has(rule.matchingRule.id) || !ruleReadable(ctx, object, rule.matchingRule)) continue;
      seen.add(rule.matchingRule.id);
      const matches = await this.matchesFor(tx, ctx, object, rule.matchingRule, values, id);
      const named = await this.named(tx, ctx, object, matches);
      if (named.length)
        groups.push({ ruleId: rule.id, rule: rule.name, action: rule.action, matches: named });
    }
    return { groups };
  }
}
