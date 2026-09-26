/**
 * The Setup tree (§9 T5). Every page is deep-linkable; groups follow the spec's order and only
 * list pages that exist. Later phases add their items here.
 */
/** Keys of `setup.items` / `setup.groups` in the message catalogue. */
export type SetupItemKey =
  'users' | 'orgUnits' | 'profiles' | 'permissionSets' | 'permissionSetGroups';
export type SetupGroupKey = 'usersAccess' | 'security';

export interface SetupItem {
  key: SetupItemKey;
  href: string;
}

export interface SetupGroup {
  key: SetupGroupKey;
  items: SetupItem[];
}

export const SETUP_TREE: SetupGroup[] = [
  {
    key: 'usersAccess',
    items: [
      { key: 'users', href: '/setup/users' },
      { key: 'orgUnits', href: '/setup/org-units' },
      { key: 'profiles', href: '/setup/profiles' },
      { key: 'permissionSets', href: '/setup/permission-sets' },
      { key: 'permissionSetGroups', href: '/setup/permission-set-groups' },
    ],
  },
];

export const SETUP_HOME = '/setup/users';

export function setupItemFor(pathname: string): SetupItem | undefined {
  return SETUP_TREE.flatMap((g) => g.items).find(
    (i) => pathname === i.href || pathname.startsWith(`${i.href}/`),
  );
}
