import { describe, expect, it } from 'vitest';

import { toggleObjectFlag } from '../src/lib/grants';

const NONE = {
  read: false,
  create: false,
  edit: false,
  delete: false,
  viewAll: false,
  modifyAll: false,
};

describe('toggleObjectFlag (§6.2 dependencies, as the server applies them)', () => {
  it('turning a flag on brings what it depends on', () => {
    expect(toggleObjectFlag(NONE, 'modifyAll', true, 'grant')).toEqual({
      read: true,
      create: false,
      edit: true,
      delete: true,
      viewAll: true,
      modifyAll: true,
    });
    expect(toggleObjectFlag(NONE, 'edit', true, 'grant')).toMatchObject({ read: true, edit: true });
  });

  it('turning a flag off removes what depended on it', () => {
    const full = toggleObjectFlag(NONE, 'modifyAll', true, 'grant');
    expect(toggleObjectFlag(full, 'read', false, 'grant')).toEqual(NONE);
    expect(toggleObjectFlag(full, 'edit', false, 'grant')).toEqual({
      ...NONE,
      read: true,
      viewAll: true,
    });
  });

  it('muting keeps exactly what is ticked', () => {
    expect(toggleObjectFlag(NONE, 'delete', true, 'muting')).toEqual({ ...NONE, delete: true });
  });
});
