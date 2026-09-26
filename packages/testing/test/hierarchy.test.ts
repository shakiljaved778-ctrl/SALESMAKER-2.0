import {
  createCellPrisma,
  disposeCellPrisma,
  visibility,
  withTenant,
  type CellPrisma,
} from '@sm/db';
import { createTestCellDatabase, type TestCellDatabase } from '@sm/db/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { makeTenantWithHierarchy, type TenantHierarchy } from '../src/hierarchy.js';

let db: TestCellDatabase;
let prisma: CellPrisma;
let h: TenantHierarchy;

beforeAll(async () => {
  db = await createTestCellDatabase(inject('pgServerAdminUrl'));
  prisma = createCellPrisma(db.appUrl);
  h = await makeTenantWithHierarchy(prisma, { depth: 2, usersPerUnit: 2, slug: 'acme' });
});

afterAll(async () => {
  await disposeCellPrisma(prisma);
  await db.drop();
});

describe('makeTenantWithHierarchy', () => {
  it('builds a full tree with users in every unit', () => {
    expect(h.units.map((u) => u.name)).toEqual([
      'U',
      'U.0',
      'U.0.0',
      'U.0.1',
      'U.1',
      'U.1.0',
      'U.1.1',
    ]);
    expect(h.users).toHaveLength(14);
    expect(h.unit('U.1.0').parentId).toBe(h.unit('U.1').id);
    expect(h.user('U.0#1').email).toBe('u-0-1@acme.test');
    expect(() => h.user('nobody')).toThrow(/no nobody/);
  });

  it('sets managers: members report to the head, heads to the parent unit’s head', () => {
    expect(h.user('U#0').managerId).toBeNull();
    expect(h.user('U.0#0').managerId).toBe(h.user('U#0').id);
    expect(h.user('U.0#1').managerId).toBe(h.user('U.0#0').id);
  });

  it('builds owner visibility', async () => {
    const seen = await withTenant(prisma, { tenantId: h.tenantId }, (tx) =>
      visibility.ownersVisibleTo(tx, h.user('U.0#0').id),
    );
    const expected = ['U.0#0', 'U.0#1', 'U.0.0#0', 'U.0.0#1', 'U.0.1#0', 'U.0.1#1'].map(
      (n) => h.user(n).id,
    );
    expect(seen).toEqual(expected.sort());
  });

  it('can grow flatter trees', async () => {
    const flat = await makeTenantWithHierarchy(prisma, { depth: 1, usersPerUnit: 1, branching: 3 });
    expect(flat.units).toHaveLength(4);
    expect(flat.users.every((u) => u.email.endsWith('.test'))).toBe(true);
  });
});
