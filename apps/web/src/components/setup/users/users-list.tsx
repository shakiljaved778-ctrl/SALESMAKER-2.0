'use client';

import type { UserSummary } from '@sm/contracts';
import { Banner, Button, EmptyState, Input, Select, Skeleton, StatusChip } from '@sm/ui';
import { Search, UserPlus, Users } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import type { z } from 'zod';

import type { ApiResult } from '../../../lib/client-api';
import { cellApi, query } from '../../../lib/cell-api';
import { SetupHeader, useHasPermission } from '../setup-shell';
import { useSetupProblem } from '../use-problem';
import { InviteDialog } from './invite-dialog';

type User = z.infer<typeof UserSummary>;
type StatusFilter = '' | 'PENDING' | 'ACTIVE' | 'DEACTIVATED';
interface Page {
  items: User[];
  nextCursor: string | null;
}

export function statusOf(user: Pick<User, 'status' | 'deactivated'>) {
  return user.deactivated ? 'DEACTIVATED' : user.status;
}

const TONE = {
  PENDING: 'info',
  ACTIVE: 'success',
  DISABLED: 'warning',
  DEACTIVATED: 'neutral',
} as const;
/** Message keys are camelCase (catalogue rule); the API's statuses are upper case. */
const STATUS_KEY = {
  PENDING: 'pending',
  ACTIVE: 'active',
  DISABLED: 'disabled',
  DEACTIVATED: 'deactivated',
} as const;

export function UserStatus({ user }: { user: Pick<User, 'status' | 'deactivated'> }) {
  const t = useTranslations('setup.users.status');
  const status = statusOf(user);
  return (
    <StatusChip tone={TONE[status]} dot>
      {t(STATUS_KEY[status])}
    </StatusChip>
  );
}

/** Setup → Users (§6.1): search, filter by status, keyset paging, invite. */
export function UsersList() {
  const t = useTranslations('setup.users');
  const tc = useTranslations('setup.common');
  const problem = useSetupProblem();
  const canManage = useHasPermission('manage_users');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('');
  const [users, setUsers] = useState<User[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiResult<unknown> | null>(null);
  const [inviting, setInviting] = useState(false);

  const load = useCallback(
    async (after: string | null) => {
      const result = await cellApi<Page>(
        'GET',
        `/v1/users${query({ q: search.trim(), status, cursor: after, limit: 50 })}`,
      );
      if (!result.ok) {
        setFailure(result);
        return;
      }
      setFailure(null);
      setUsers((prev) => (after && prev ? [...prev, ...result.data.items] : result.data.items));
      setCursor(result.data.nextCursor);
    },
    [search, status],
  );

  useEffect(() => {
    const timer = setTimeout(() => void load(null), 200);
    return () => {
      clearTimeout(timer);
    };
  }, [load]);

  return (
    <>
      <SetupHeader
        title={t('title')}
        description={t('description')}
        actions={
          canManage ? (
            <Button
              variant="primary"
              icon={<UserPlus />}
              onClick={() => {
                setInviting(true);
              }}
            >
              {t('invite')}
            </Button>
          ) : null
        }
      />
      <div className="flex flex-col gap-4 p-[var(--page-padding)]">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-80 max-w-full">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute start-2 top-1/2 size-4 -translate-y-1/2 text-fg-secondary"
            />
            <Input
              type="search"
              aria-label={t('searchPlaceholder')}
              placeholder={t('searchPlaceholder')}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
              }}
              className="ps-8"
            />
          </div>
          <Select
            aria-label={t('statusFilter')}
            value={status || 'ALL'}
            onValueChange={(v) => {
              setStatus(v === 'ALL' ? '' : (v as StatusFilter));
            }}
            options={[
              { value: 'ALL', label: t('allStatuses') },
              { value: 'ACTIVE', label: t('status.active') },
              { value: 'PENDING', label: t('status.pending') },
              { value: 'DEACTIVATED', label: t('status.deactivated') },
            ]}
            className="w-44"
          />
        </div>
        {failure ? (
          <Banner tone="danger">
            {problem(failure)}{' '}
            <Button variant="link" onClick={() => void load(null)}>
              {tc('reload')}
            </Button>
          </Banner>
        ) : null}
        {users === null ? (
          <div aria-busy="true" className="flex flex-col gap-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : users.length === 0 ? (
          <EmptyState
            icon={<Users />}
            title={t('empty.title')}
            description={t('empty.description')}
          />
        ) : (
          <table className="w-full border-collapse text-body-sm">
            <thead>
              <tr className="border-b border-line text-start text-caption text-fg-secondary">
                {(['name', 'email', 'profile', 'orgUnit', 'status'] as const).map((c) => (
                  <th key={c} scope="col" className="px-3 py-2 text-start font-medium">
                    {t(`columns.${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-line-subtle hover:bg-hover">
                  <td className="px-3 py-2">
                    <Link href={`/setup/users/${u.id}`} className="font-medium text-link">
                      {u.name}
                    </Link>
                    {u.title ? <p className="text-caption text-fg-secondary">{u.title}</p> : null}
                  </td>
                  <td className="px-3 py-2 text-fg-secondary">{u.email}</td>
                  <td className="px-3 py-2">{u.profile?.name ?? tc('none')}</td>
                  <td className="px-3 py-2">{u.orgUnit?.name ?? tc('none')}</td>
                  <td className="px-3 py-2">
                    <UserStatus user={u} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {cursor ? (
          <Button className="self-center" onClick={() => void load(cursor)}>
            {tc('loadMore')}
          </Button>
        ) : null}
      </div>
      {inviting ? (
        <InviteDialog
          onClose={(invited) => {
            setInviting(false);
            if (invited) void load(null);
          }}
        />
      ) : null}
    </>
  );
}
