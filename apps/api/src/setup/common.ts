import { outbox, type TenantTransaction } from '@sm/db';
import { DomainError, errors } from '@sm/server-kit';

/** Topic the worker recalculates one sharing rule on (apps/worker sharing handler). */
export const RULE_CHANGED = 'sharing.rule_changed';
export const RULE_DELETED = 'sharing.rule_deleted';

export const staleVersion = (what: string) =>
  new DomainError(
    'version_conflict',
    409,
    `Someone else changed this ${what}; reload and try again`,
  );

export const nameTaken = () => errors.conflict('That name is already in use');

export const invalid = (field: string, message: string, code = 'invalid') =>
  errors.validation([{ field, code, message }]);

const messageOf = (err: unknown) => (err instanceof Error ? err.message : '');

/** A unique-constraint violation (Prisma P2002 or a raw 23505). */
export function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return (
    code === 'P2002' || code === '23505' || /Unique constraint|duplicate key/i.test(messageOf(err))
  );
}

/** Map the database's structural refusals to 409s; anything else is rethrown unchanged. */
export function rethrowConflict(err: unknown): never {
  const message = messageOf(err);
  if (isUniqueViolation(err)) throw nameTaken();
  if (/group_member_no_cycle|cannot contain itself/.test(message))
    throw errors.conflict('A group cannot contain itself, directly or through other groups');
  if (/org_unit_no_cycle|own subtree/.test(message))
    throw errors.conflict('An org unit cannot move under itself or one of its own units');
  throw err;
}

/**
 * Owner-based sharing rules match records by who owns them, so any change to who is in a group,
 * an org unit or a subtree may change their shares. Each active one is recalculated in the
 * background (ADR-0007: converges in under 60 s).
 */
export async function recalculateOwnerRules(tx: TenantTransaction): Promise<number> {
  const rules = await tx.prisma.sharingRule.findMany({
    where: { kind: 'OWNER', active: true },
    select: { id: true },
  });
  await outbox.emit(
    tx,
    rules.map((r) => ({ topic: RULE_CHANGED, payload: { ruleId: r.id } })),
  );
  return rules.length;
}

/** Optimistic update: throws 404 when missing and 409 when the version is stale. */
export function assertVersion<T extends { version: number }>(
  current: T | null,
  version: number,
  what: string,
): asserts current is T {
  if (!current) throw errors.notFound(what);
  if (current.version !== version) throw staleVersion(what.toLowerCase());
}
