import { normaliseObjectAccess, restrictObjectAccess, type ObjectAccess } from '@sm/permissions';

export const FLAGS = ['read', 'create', 'edit', 'delete', 'viewAll', 'modifyAll'] as const;
export type Flag = (typeof FLAGS)[number];

/**
 * Turning a flag on brings its dependencies with it; turning one off removes whatever depended
 * on it (§6.2) — the same closure the server applies. Muting sets keep exactly what is ticked.
 */
export function toggleObjectFlag(
  access: ObjectAccess,
  flag: Flag,
  on: boolean,
  mode: 'grant' | 'muting',
): ObjectAccess {
  const next = { ...access, [flag]: on };
  if (mode === 'muting') return next;
  return on ? normaliseObjectAccess(next) : restrictObjectAccess(next);
}
