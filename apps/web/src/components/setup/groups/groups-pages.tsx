'use client';

import type { PublicGroupDto, QueueDto } from '@sm/contracts';
import { camelCase, STANDARD_OBJECTS } from '@sm/metadata';
import { Banner, Button, Checkbox, EmptyState, FormField, Input, useToast } from '@sm/ui';
import { Inbox, Plus, Users } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState, type ReactNode } from 'react';
import type { z } from 'zod';

import { cellApi } from '../../../lib/cell-api';
import {
  BackLink,
  CreateDialog,
  DeleteDialog,
  NameFields,
  ResourceState,
  useResource,
} from '../common';
import { SetupHeader, useHasPermission } from '../setup-shell';
import { useSetupProblem } from '../use-problem';
import { MembersEditor, type Member } from './members-editor';

type Group = z.infer<typeof PublicGroupDto>;
type Queue = z.infer<typeof QueueDto>;

function useObjectLabel() {
  const t = useTranslations();
  return (apiName: string) => t(`objects.${camelCase(apiName)}.plural` as Parameters<typeof t>[0]);
}

/** Checkboxes for the objects a queue holds. */
function ObjectChoices({
  value,
  onChange,
  readOnly,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  readOnly?: boolean;
}) {
  const t = useTranslations('setup.queues');
  const label = useObjectLabel();
  return (
    <fieldset className="flex flex-col gap-2" disabled={readOnly}>
      <legend className="pb-2 text-label text-fg">{t('objects')}</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {STANDARD_OBJECTS.map((o) => (
          <Checkbox
            key={o.apiName}
            label={label(o.apiName)}
            checked={value.includes(o.apiName)}
            disabled={readOnly}
            onCheckedChange={(c) => {
              const rest = value.filter((x) => x !== o.apiName);
              onChange(c === true ? [...rest, o.apiName].sort() : rest);
            }}
          />
        ))}
      </div>
    </fieldset>
  );
}

function ListTable<T extends { id: string; name: string }>({
  rows,
  href,
  cells,
}: {
  rows: T[];
  href: (row: T) => string;
  cells: { label: string; render: (row: T) => ReactNode; numeric?: boolean }[];
}) {
  const tc = useTranslations('setup.common');
  return (
    <table className="w-full border-collapse text-body-sm">
      <thead>
        <tr className="border-b border-line text-caption text-fg-secondary">
          <th scope="col" className="px-3 py-2 text-start font-medium">
            {tc('name')}
          </th>
          {cells.map((c) => (
            <th
              key={c.label}
              scope="col"
              className={`px-3 py-2 font-medium ${c.numeric ? 'text-end' : 'text-start'}`}
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
            {cells.map((c) => (
              <td
                key={c.label}
                className={`px-3 py-2 ${c.numeric ? 'text-end tabular-nums' : 'text-fg-secondary'}`}
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

export function GroupsList() {
  const t = useTranslations('setup.publicGroups');
  const tm = useTranslations('setup.members');
  const tc = useTranslations('setup.common');
  const router = useRouter();
  const canManage = useHasPermission('manage_users');
  const { data, failure } = useResource<{ items: Group[] }>('/v1/groups');
  const [creating, setCreating] = useState(false);
  if (!data) return <ResourceState failure={failure} loading={!failure} />;
  return (
    <>
      <SetupHeader
        title={t('title')}
        description={t('description')}
        actions={
          canManage ? (
            <Button
              variant="primary"
              icon={<Plus />}
              onClick={() => {
                setCreating(true);
              }}
            >
              {t('new')}
            </Button>
          ) : null
        }
      />
      <div className="p-[var(--page-padding)]">
        {data.items.length === 0 ? (
          <EmptyState
            icon={<Users />}
            title={t('empty.title')}
            description={t('empty.description')}
          />
        ) : (
          <ListTable
            rows={data.items}
            href={(g) => `/setup/groups/${g.id}`}
            cells={[
              { label: tc('description'), render: (g) => g.description },
              { label: tm('title'), numeric: true, render: (g) => g.members.length },
              { label: tc('users'), numeric: true, render: (g) => g.userCount },
            ]}
          />
        )}
      </div>
      {creating ? (
        <CreateDialog
          title={t('new')}
          path="/v1/groups"
          body={{ members: [] }}
          onClose={() => {
            setCreating(false);
          }}
          onCreated={(g) => {
            router.push(`/setup/groups/${g.id}`);
          }}
        />
      ) : null}
    </>
  );
}

export function QueuesList() {
  const t = useTranslations('setup.queues');
  const tm = useTranslations('setup.members');
  const tc = useTranslations('setup.common');
  const label = useObjectLabel();
  const router = useRouter();
  const canManage = useHasPermission('manage_users');
  const { data, failure } = useResource<{ items: Queue[] }>('/v1/queues');
  const [creating, setCreating] = useState(false);
  const [objects, setObjects] = useState<string[]>(['lead']);
  if (!data) return <ResourceState failure={failure} loading={!failure} />;
  return (
    <>
      <SetupHeader
        title={t('title')}
        description={t('description')}
        actions={
          canManage ? (
            <Button
              variant="primary"
              icon={<Plus />}
              onClick={() => {
                setCreating(true);
              }}
            >
              {t('new')}
            </Button>
          ) : null
        }
      />
      <div className="p-[var(--page-padding)]">
        {data.items.length === 0 ? (
          <EmptyState
            icon={<Inbox />}
            title={t('empty.title')}
            description={t('empty.description')}
          />
        ) : (
          <ListTable
            rows={data.items}
            href={(q) => `/setup/queues/${q.id}`}
            cells={[
              { label: t('objects'), render: (q) => q.objects.map(label).join(', ') },
              { label: tm('title'), numeric: true, render: (q) => q.members.length },
              { label: tc('users'), numeric: true, render: (q) => q.userCount },
            ]}
          />
        )}
      </div>
      {creating ? (
        <CreateDialog
          title={t('new')}
          path="/v1/queues"
          body={{ objects, members: [] }}
          extra={<ObjectChoices value={objects} onChange={setObjects} />}
          onClose={() => {
            setCreating(false);
          }}
          onCreated={(q) => {
            router.push(`/setup/queues/${q.id}`);
          }}
        />
      ) : null}
    </>
  );
}

interface Draft {
  name: string;
  description: string;
  email: string;
  objects: string[];
  members: Member[];
}

const draftOf = (e: Group | Queue): Draft => ({
  name: e.name,
  description: e.description ?? '',
  email: 'email' in e ? (e.email ?? '') : '',
  objects: 'objects' in e ? e.objects : [],
  members: e.members,
});

/** One public group or queue: name, description, members (and a queue's email and objects). */
export function MembershipDetail({ kind, id }: { kind: 'groups' | 'queues'; id: string }) {
  const tg = useTranslations('setup.publicGroups');
  const tq = useTranslations('setup.queues');
  const tm = useTranslations('setup.members');
  const tc = useTranslations('setup.common');
  const common = useTranslations('common');
  const toast = useToast();
  const router = useRouter();
  const problem = useSetupProblem();
  const canManage = useHasPermission('manage_users');
  const queue = kind === 'queues';
  const path = `/v1/${kind}/${id}`;
  const { data, failure, replace } = useResource<Group | Queue>(path);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (data) setDraft(draftOf(data));
  }, [data]);

  if (!data || !draft) return <ResourceState failure={failure} loading={!failure} />;
  const original = draftOf(data);
  const dirty = JSON.stringify(original) !== JSON.stringify(draft);
  const readOnly = !canManage;

  const save = async () => {
    setSaving(true);
    const result = await cellApi<Group | Queue>('PATCH', path, {
      version: data.version,
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      members: draft.members.map((m) => ({ type: m.type, id: m.id })),
      ...(queue ? { email: draft.email.trim() || null, objects: draft.objects } : {}),
    });
    setSaving(false);
    if (!result.ok) {
      toast({
        tone: 'error',
        title: problem(result, {
          conflict: queue ? tc('nameTaken') : tg('conflict'),
        }),
      });
      return;
    }
    replace(result.data);
    toast({ tone: 'success', title: tc('saved') });
  };

  const title = queue ? tq('title') : tg('title');
  return (
    <>
      <SetupHeader
        breadcrumb={<BackLink href={`/setup/${kind}`}>{title}</BackLink>}
        title={data.name}
        description={tm('userCount', { count: data.userCount })}
        actions={
          canManage ? (
            <Button
              variant="danger"
              onClick={() => {
                setDeleting(true);
              }}
            >
              {tc('delete')}
            </Button>
          ) : null
        }
      />
      <div className="flex max-w-4xl flex-col gap-6 p-[var(--page-padding)]">
        {readOnly ? <Banner tone="info">{tc('notAllowed')}</Banner> : null}
        <NameFields
          name={draft.name}
          description={draft.description}
          readOnly={readOnly}
          onChange={(next) => {
            setDraft({ ...draft, ...next });
          }}
        />
        {queue ? (
          <>
            <FormField label={tq('email')} disabled={readOnly}>
              <Input
                type="email"
                value={draft.email}
                onChange={(e) => {
                  setDraft({ ...draft, email: e.target.value });
                }}
              />
            </FormField>
            <ObjectChoices
              value={draft.objects}
              readOnly={readOnly}
              onChange={(objects) => {
                setDraft({ ...draft, objects });
              }}
            />
          </>
        ) : null}
        <section className="flex flex-col gap-3" aria-labelledby="members-heading">
          <h2 id="members-heading" className="text-title-3 text-fg">
            {tm('title')}
          </h2>
          <MembersEditor
            value={draft.members}
            readOnly={readOnly}
            {...(queue ? {} : { excludeGroup: id })}
            onChange={(members) => {
              setDraft({ ...draft, members });
            }}
          />
        </section>
        {canManage ? (
          <div className="sticky bottom-0 flex items-center gap-2 border-t border-line bg-canvas py-3">
            <Button
              variant="primary"
              disabled={!dirty || saving || (queue && draft.objects.length === 0)}
              onClick={() => void save()}
            >
              {tc('saveChanges')}
            </Button>
            <Button
              disabled={!dirty || saving}
              onClick={() => {
                setDraft(original);
              }}
            >
              {common('actions.cancel')}
            </Button>
            {queue && draft.objects.length === 0 ? (
              <span role="status" className="text-body-sm text-danger">
                {tq('objectsRequired')}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <DeleteDialog
        open={deleting}
        onOpenChange={setDeleting}
        name={data.name}
        path={path}
        inUse={queue ? tc('inUse') : tg('inUse')}
        onDeleted={() => {
          router.push(`/setup/${kind}`);
        }}
      />
    </>
  );
}
