'use client';

import type { UserDetail as UserDetailDto } from '@sm/contracts';
import { Banner, Button, Combobox, Dialog, FormField, Input, Skeleton, useToast } from '@sm/ui';
import { ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState, type SyntheticEvent } from 'react';
import type { z } from 'zod';

import type { ApiResult } from '../../../lib/client-api';
import { cellApi } from '../../../lib/cell-api';
import { useShell } from '../../shell/app-shell';
import { UserPicker, useSetupOptions } from '../pickers';
import { SetupHeader, useHasPermission } from '../setup-shell';
import { useSetupProblem } from '../use-problem';
import { UserStatus } from './users-list';

type User = z.infer<typeof UserDetailDto>;

interface Draft {
  name: string;
  title: string;
  department: string;
  phone: string;
  profileId: string;
  orgUnitId: string;
  managerId: string | null;
}

const draftOf = (u: User): Draft => ({
  name: u.name,
  title: u.title ?? '',
  department: u.department ?? '',
  phone: u.phone ?? '',
  profileId: u.profile?.id ?? '',
  orgUnitId: u.orgUnit?.id ?? '',
  managerId: u.manager?.id ?? null,
});

/** Setup → Users → one user (§6.1): details, placement, access, invitation and deactivation. */
export function UserDetail({ id }: { id: string }) {
  const t = useTranslations('setup.users.detail');
  const tc = useTranslations('setup.common');
  const common = useTranslations('common');
  const format = useFormatter();
  const toast = useToast();
  const router = useRouter();
  const problem = useSetupProblem();
  const { user: me } = useShell();
  const canManage = useHasPermission('manage_users');
  const { profiles, units } = useSetupOptions();
  const [user, setUser] = useState<User | null>(null);
  const [failure, setFailure] = useState<ApiResult<unknown> | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void cellApi<User>('GET', `/v1/users/${id}`).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setUser(result.data);
        setDraft(draftOf(result.data));
        setFailure(null);
      } else setFailure(result);
    });
    return () => {
      cancelled = true;
    };
  }, [id, reload]);

  const refresh = () => {
    setReload((n) => n + 1);
  };
  const act = async (
    method: 'POST' | 'DELETE',
    path: string,
    success: string,
    specific: Record<string, string> = {},
  ) => {
    const result = await cellApi<User>(method, path);
    if (!result.ok) {
      toast({ tone: 'error', title: problem(result, specific) });
      return false;
    }
    toast({ tone: 'success', title: success });
    return true;
  };

  if (failure && !user) {
    return (
      <div className="p-[var(--page-padding)]">
        <Banner tone="danger">{problem(failure)}</Banner>
      </div>
    );
  }
  if (!user || !draft) {
    return (
      <div aria-busy="true" className="flex flex-col gap-3 p-[var(--page-padding)]">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const original = draftOf(user);
  const dirty = JSON.stringify(original) !== JSON.stringify(draft);
  const set = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch });
  };
  const save = async (event: SyntheticEvent) => {
    event.preventDefault();
    const changes: Record<string, unknown> = {};
    const text = (v: string) => v.trim() || null;
    if (draft.name !== original.name) changes['name'] = draft.name.trim();
    if (draft.title !== original.title) changes['title'] = text(draft.title);
    if (draft.department !== original.department) changes['department'] = text(draft.department);
    if (draft.phone !== original.phone) changes['phone'] = text(draft.phone);
    if (draft.profileId !== original.profileId) changes['profileId'] = draft.profileId;
    if (draft.orgUnitId !== original.orgUnitId) changes['orgUnitId'] = draft.orgUnitId || null;
    if (draft.managerId !== original.managerId) changes['managerId'] = draft.managerId;
    setSaving(true);
    const result = await cellApi<User>('PATCH', `/v1/users/${id}`, {
      version: user.version,
      ...changes,
    });
    setSaving(false);
    if (!result.ok) {
      toast({ tone: 'error', title: problem(result, { conflict: t('managerCycle') }) });
      return;
    }
    setUser(result.data);
    setDraft(draftOf(result.data));
    toast({ tone: 'success', title: tc('saved') });
  };

  const pending = user.status === 'PENDING';
  const readOnly = !canManage;
  const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium' });

  return (
    <>
      <SetupHeader
        breadcrumb={
          <Link
            href="/setup/users"
            className="inline-flex items-center gap-1 text-body-sm text-link"
          >
            <ChevronLeft aria-hidden="true" data-mirror="" className="size-4" />
            {t('allUsers')}
          </Link>
        }
        title={user.name}
        description={user.email}
        actions={
          canManage ? (
            pending ? (
              <>
                <Button
                  onClick={() =>
                    void act('POST', `/v1/invitations/${id}/resend`, t('resent')).then(refresh)
                  }
                >
                  {t('resend')}
                </Button>
                <Button
                  variant="danger"
                  onClick={() =>
                    void act('DELETE', `/v1/invitations/${id}`, t('withdrawn')).then((ok) => {
                      if (ok) router.push('/setup/users');
                    })
                  }
                >
                  {t('withdraw')}
                </Button>
              </>
            ) : user.deactivated ? (
              <Button
                onClick={() =>
                  void act(
                    'POST',
                    `/v1/users/${id}/reactivate`,
                    t('reactivated', { name: user.name }),
                  ).then(refresh)
                }
              >
                {t('reactivate')}
              </Button>
            ) : user.id !== me?.id ? (
              <Button
                variant="danger"
                onClick={() => {
                  setConfirming(true);
                }}
              >
                {t('deactivate')}
              </Button>
            ) : null
          ) : null
        }
      />
      <div className="flex max-w-3xl flex-col gap-6 p-[var(--page-padding)]">
        <div className="flex items-center gap-2">
          <UserStatus user={user} />
        </div>
        {user.invitation ? (
          <Banner tone={user.invitation.expired ? 'warning' : 'info'}>
            {user.invitation.expired
              ? t('invitationExpired', { expiresAt: date(user.invitation.expiresAt) })
              : t('invitationPending', {
                  sentAt: date(user.invitation.sentAt),
                  expiresAt: date(user.invitation.expiresAt),
                })}
          </Banner>
        ) : null}

        <form noValidate onSubmit={(e) => void save(e)} className="flex flex-col gap-4">
          <h2 className="text-title-3 text-fg">{t('details')}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('name')} required disabled={readOnly}>
              <Input
                value={draft.name}
                onChange={(e) => {
                  set({ name: e.target.value });
                }}
              />
            </FormField>
            <FormField label={t('jobTitle')} disabled={readOnly}>
              <Input
                value={draft.title}
                onChange={(e) => {
                  set({ title: e.target.value });
                }}
              />
            </FormField>
            <FormField label={t('department')} disabled={readOnly}>
              <Input
                value={draft.department}
                onChange={(e) => {
                  set({ department: e.target.value });
                }}
              />
            </FormField>
            <FormField label={t('phone')} disabled={readOnly}>
              <Input
                type="tel"
                value={draft.phone}
                onChange={(e) => {
                  set({ phone: e.target.value });
                }}
              />
            </FormField>
          </div>
          <h2 className="text-title-3 text-fg">{t('access')}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('profile')} required disabled={readOnly}>
              <Combobox
                options={profiles ?? []}
                loading={profiles === null}
                loadingText={common('states.loading')}
                value={draft.profileId}
                onValueChange={(v) => {
                  set({ profileId: v });
                }}
                placeholder={t('profile')}
                searchPlaceholder={common('search.placeholder')}
                emptyText={common('search.noResults')}
                disabled={readOnly}
              />
            </FormField>
            <FormField label={t('orgUnit')} disabled={readOnly}>
              <Combobox
                options={[{ value: '', label: tc('none') }, ...(units ?? [])]}
                loading={units === null}
                loadingText={common('states.loading')}
                value={draft.orgUnitId}
                onValueChange={(v) => {
                  set({ orgUnitId: v });
                }}
                placeholder={t('orgUnit')}
                searchPlaceholder={common('search.placeholder')}
                emptyText={common('search.noResults')}
                disabled={readOnly}
              />
            </FormField>
            <FormField label={t('manager')} disabled={readOnly}>
              <UserPicker
                value={draft.managerId}
                initial={user.manager}
                exclude={user.id}
                onChange={(v) => {
                  set({ managerId: v });
                }}
                placeholder={t('manager')}
              />
            </FormField>
          </div>
          <dl className="grid gap-4 text-body-sm sm:grid-cols-2">
            <div>
              <dt className="text-caption text-fg-secondary">{t('permissionSets')}</dt>
              <dd>{user.permissionSets.map((s) => s.name).join(', ') || t('noneAssigned')}</dd>
            </div>
            <div>
              <dt className="text-caption text-fg-secondary">{t('permissionSetGroups')}</dt>
              <dd>{user.permissionSetGroups.map((s) => s.name).join(', ') || t('noneAssigned')}</dd>
            </div>
          </dl>
          {canManage ? (
            <div className="flex gap-2">
              <Button type="submit" variant="primary" disabled={!dirty || saving}>
                {t('save')}
              </Button>
              <Button
                type="button"
                disabled={!dirty || saving}
                onClick={() => {
                  setDraft(original);
                }}
              >
                {common('actions.cancel')}
              </Button>
            </div>
          ) : null}
        </form>
      </div>
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('deactivateTitle', { name: user.name })}
        description={t('deactivateBody')}
        closeLabel={common('actions.close')}
        size="sm"
        footer={
          <>
            <Button
              onClick={() => {
                setConfirming(false);
              }}
            >
              {common('actions.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirming(false);
                void act(
                  'POST',
                  `/v1/users/${id}/deactivate`,
                  t('deactivated', { name: user.name }),
                  {
                    conflict: t('cannotDeactivate'),
                  },
                ).then(refresh);
              }}
            >
              {t('deactivate')}
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </>
  );
}
