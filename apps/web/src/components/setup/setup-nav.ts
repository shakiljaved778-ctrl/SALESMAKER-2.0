/**
 * The Setup tree (§9 T5). Every page is deep-linkable; groups follow the spec's order and only
 * list pages that exist. Later phases add their items here.
 */
/** Keys of `setup.items` / `setup.groups` in the message catalogue. */
export type SetupItemKey =
  | 'users'
  | 'orgUnits'
  | 'profiles'
  | 'permissionSets'
  | 'permissionSetGroups'
  | 'groups'
  | 'queues'
  | 'sharing'
  | 'auditLog'
  | 'loginHistory'
  | 'setupAudit';
export type SetupGroupKey = 'usersAccess' | 'sharing' | 'security';

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
  {
    key: 'sharing',
    items: [
      { key: 'groups', href: '/setup/groups' },
      { key: 'queues', href: '/setup/queues' },
      { key: 'sharing', href: '/setup/sharing' },
    ],
  },
  {
    key: 'security',
    items: [
      { key: 'auditLog', href: '/setup/audit-log' },
      { key: 'loginHistory', href: '/setup/login-history' },
      { key: 'setupAudit', href: '/setup/setup-audit' },
    ],
  },
];

export const SETUP_HOME = '/setup/users';

export function setupItemFor(pathname: string): SetupItem | undefined {
  return SETUP_TREE.flatMap((g) => g.items).find(
    (i) => pathname === i.href || pathname.startsWith(`${i.href}/`),
  );
}
