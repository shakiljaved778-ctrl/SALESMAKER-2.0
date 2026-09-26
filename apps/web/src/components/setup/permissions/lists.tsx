'use client';

import type { PermissionSetGroupDetail, PermissionSetSummary, ProfileSummary } from '@sm/contracts';
import { Button, Combobox, EmptyState, FormField, StatusChip } from '@sm/ui';
import { Plus, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import type { z } from 'zod';

import { CreateDialog, ResourceState, useResource } from '../common';
import { SetupHeader, useHasPermission } from '../setup-shell';

interface Column<T> {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
  numeric?: boolean;
}

function SetupTable<T extends { id: string; name: string }>({
  rows,
  href,
  columns,
}: {
  rows: T[];
  href: (row: T) => string;
  columns: Column<T>[];
}) {
  const t = useTranslations('setup.common');
  return (
    <table className="w-full border-collapse text-body-sm">
      <thead>
        <tr className="border-b border-line text-caption text-fg-secondary">
          <th scope="col" className="px-3 py-2 text-start font-medium">
            {t('name')}
          </th>
          {columns.map((c) => (
            <th
              key={c.key}
              scope="col"
              className={
                c.numeric ? 'px-3 py-2 text-end font-medium' : 'px-3 py-2 text-start font-medium'
              }
            >
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className="border-b border-line-subtle hover:bg-hover">
            <td className="px-3 py-2">
              <Link href={href(row)} className="font-medium text-link">
                {row.name}
              </Link>
            </td>
            {columns.map((c) => (
              <td
                key={c.key}
                className={
                  c.numeric ? 'px-3 py-2 text-end tabular-nums' : 'px-3 py-2 text-fg-secondary'
                }
              >
                {c.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ListPage<T extends { id: string; name: string }>({
  title,
  description,
  newLabel,
  empty,
  rows,
  href,
  columns,
  onNew,
}: {
  title: string;
  description: string;
  newLabel: string;
  empty: { title: string; description: string };
  rows: T[];
  href: (row: T) => string;
  columns: Column<T>[];
  onNew: () => void;
}) {
  const canManage = useHasPermission('manage_users');
  return (
    <>
      <SetupHeader
        title={title}
        description={description}
        actions={
          canManage ? (
            <Button variant="primary" icon={<Plus />} onClick={onNew}>
              {newLabel}
            </Button>
          ) : null
        }
      />
      <div className="p-[var(--page-padding)]">
        {rows.length === 0 ? (
          <EmptyState icon={<ShieldCheck />} title={empty.title} description={empty.description} />
        ) : (
          <SetupTable rows={rows} href={href} columns={columns} />
        )}
      </div>
    </>
  );
}

type Profile = z.infer<typeof ProfileSummary>;
type PermissionSet = z.infer<typeof PermissionSetSummary>;
type PermissionSetGroup = z.infer<typeof PermissionSetGroupDetail>;

export function ProfilesList() {
  const t = useTranslations('setup.profiles');
  const tc = useTranslations('setup.common');
  const common = useTranslations('common');
  const router = useRouter();
  const { data, failure } = useResource<{ items: Profile[] }>('/v1/profiles');
  const [creating, setCreating] = useState(false);
  const [cloneFrom, setCloneFrom] = useState('');
  if (!data) return <ResourceState failure={failure} loading={!failure} />;
  return (
    <>
      <ListPage
        title={t('title')}
        description={t('description')}
        newLabel={t('new')}
        empty={{ title: t('empty.title'), description: t('empty.description') }}
        rows={data.items}
        href={(p) => `/setup/profiles/${p.id}`}
        onNew={() => {
          setCreating(true);
        }}
        columns={[
          {
            key: 'kind',
            label: '',
            render: (p) => (p.systemKey ? <StatusChip>{tc('builtIn')}</StatusChip> : null),
          },
          { key: 'description', label: tc('description'), render: (p) => p.description },
          { key: 'users', label: tc('users'), numeric: true, render: (p) => p.users },
        ]}
      />
      {creating ? (
        <CreateDialog
          title={t('new')}
          path="/v1/profiles"
          body={cloneFrom ? { cloneFrom } : {}}
          extra={
            <FormField label={t('cloneFrom')}>
              <Combobox
                options={[
                  { value: '', label: t('cloneNone') },
                  ...data.items.map((p) => ({ value: p.id, label: p.name })),
                ]}
                value={cloneFrom}
                onValueChange={setCloneFrom}
                placeholder={t('cloneFrom')}
                searchPlaceholder={common('search.placeholder')}
                emptyText={common('search.noResults')}
              />
            </FormField>
          }
          onClose={() => {
            setCreating(false);
          }}
          onCreated={(p) => {
            router.push(`/setup/profiles/${p.id}`);
          }}
        />
      ) : null}
    </>
  );
}

export function PermissionSetsList() {
  const t = useTranslations('setup.permissionSets');
  const tc = useTranslations('setup.common');
  const router = useRouter();
  const { data, failure } = useResource<{ items: PermissionSet[] }>('/v1/permission-sets');
  const [creating, setCreating] = useState(false);
  if (!data) return <ResourceState failure={failure} loading={!failure} />;
  return (
    <>
      <ListPage
        title={t('title')}
        description={t('description')}
        newLabel={t('new')}
        empty={{ title: t('empty.title'), description: t('empty.description') }}
        rows={data.items}
        href={(s) => `/setup/permission-sets/${s.id}`}
        onNew={() => {
          setCreating(true);
        }}
        columns={[
          { key: 'description', label: tc('description'), render: (s) => s.description },
          { key: 'assigned', label: t('assigned'), numeric: true, render: (s) => s.assignedUsers },
          { key: 'groups', label: t('inGroups'), numeric: true, render: (s) => s.groups },
        ]}
      />
      {creating ? (
        <CreateDialog
          title={t('new')}
          path="/v1/permission-sets"
          onClose={() => {
            setCreating(false);
          }}
          onCreated={(s) => {
            router.push(`/setup/permission-sets/${s.id}`);
          }}
        />
      ) : null}
    </>
  );
}

export function PermissionSetGroupsList() {
  const t = useTranslations('setup.permissionSetGroups');
  const tp = useTranslations('setup.permissionSets');
  const router = useRouter();
  const { data, failure } = useResource<{ items: PermissionSetGroup[] }>(
    '/v1/permission-set-groups',
  );
  const [creating, setCreating] = useState(false);
  if (!data) return <ResourceState failure={failure} loading={!failure} />;
  return (
    <>
      <ListPage
        title={t('title')}
        description={t('description')}
        newLabel={t('new')}
        empty={{ title: t('empty.title'), description: t('empty.description') }}
        rows={data.items}
        href={(g) => `/setup/permission-set-groups/${g.id}`}
        onNew={() => {
          setCreating(true);
        }}
        columns={[
          {
            key: 'sets',
            label: t('sets'),
            render: (g) => g.permissionSets.map((s) => s.name).join(', '),
          },
          { key: 'assigned', label: tp('assigned'), numeric: true, render: (g) => g.assignedUsers },
        ]}
      />
      {creating ? (
        <CreateDialog
          title={t('new')}
          path="/v1/permission-set-groups"
          body={{ permissionSetIds: [] }}
          onClose={() => {
            setCreating(false);
          }}
          onCreated={(g) => {
            router.push(`/setup/permission-set-groups/${g.id}`);
          }}
        />
      ) : null}
    </>
  );
}
