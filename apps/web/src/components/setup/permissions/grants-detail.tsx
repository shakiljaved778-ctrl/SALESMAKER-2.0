'use client';

import { Banner, Button, useToast } from '@sm/ui';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { cellApi } from '../../../lib/cell-api';
import { BackLink, DeleteDialog, NameFields, ResourceState, useResource } from '../common';
import { GrantsEditor, type Grants } from '../grants-editor';
import { SetupHeader, useHasPermission } from '../setup-shell';
import { useSetupProblem } from '../use-problem';

interface Granted {
  id: string;
  name: string;
  description: string | null;
  version: number;
  grants: Grants;
  systemKey?: string | null;
}

interface Draft {
  name: string;
  description: string;
  grants: Grants;
}

const draftOf = (e: Granted): Draft => ({
  name: e.name,
  description: e.description ?? '',
  grants: e.grants,
});
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A profile or permission set (§6.2): name, description and its grants. Saving renames first,
 * then replaces the grants, each with the version the previous step returned.
 */
export function GrantsDetail({ kind, id }: { kind: 'profiles' | 'permission-sets'; id: string }) {
  const tp = useTranslations('setup.profiles');
  const ts = useTranslations('setup.permissionSets');
  const profiles = kind === 'profiles';
  const title = profiles ? tp('title') : ts('title');
  const adminLocked = tp('adminLocked');
  const inUse = profiles ? tp('usersAssigned') : ts('inUse');
  const tc = useTranslations('setup.common');
  const tg = useTranslations('setup.grants');
  const common = useTranslations('common');
  const toast = useToast();
  const router = useRouter();
  const problem = useSetupProblem();
  const canManage = useHasPermission('manage_users');
  const base = `/v1/${kind}`;
  const { data, failure, replace } = useResource<Granted>(`${base}/${id}`);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (data) setDraft(draftOf(data));
  }, [data]);

  if (!data || !draft) return <ResourceState failure={failure} loading={!failure} />;

  const locked = data.systemKey === 'system_administrator';
  const readOnly = !canManage;
  const original = draftOf(data);
  const dirty = !same(original, draft);

  const save = async () => {
    setSaving(true);
    let current = data;
    if (draft.name !== original.name || draft.description !== original.description) {
      const renamed = await cellApi<Granted>('PATCH', `${base}/${id}`, {
        version: current.version,
        name: draft.name.trim(),
        description: draft.description.trim() || null,
      });
      if (!renamed.ok) {
        setSaving(false);
        toast({ tone: 'error', title: problem(renamed, { conflict: tc('nameTaken') }) });
        return;
      }
      current = renamed.data;
    }
    if (!same(original.grants, draft.grants)) {
      const granted = await cellApi<Granted>('PUT', `${base}/${id}/grants`, {
        version: current.version,
        grants: draft.grants,
      });
      if (!granted.ok) {
        setSaving(false);
        replace(current);
        toast({ tone: 'error', title: problem(granted, { conflict: adminLocked }) });
        return;
      }
      current = granted.data;
    }
    setSaving(false);
    replace(current);
    toast({ tone: 'success', title: tc('saved') });
  };

  const deletable = canManage && !(profiles && data.systemKey);
  return (
    <>
      <SetupHeader
        breadcrumb={<BackLink href={`/setup/${kind}`}>{title}</BackLink>}
        title={data.name}
        {...(data.description ? { description: data.description } : {})}
        actions={
          deletable ? (
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
      <div className="flex max-w-5xl flex-col gap-6 p-[var(--page-padding)]">
        {locked ? <Banner tone="info">{adminLocked}</Banner> : null}
        {readOnly && !locked ? <Banner tone="info">{tg('readOnlyNote')}</Banner> : null}
        <NameFields
          name={draft.name}
          description={draft.description}
          readOnly={readOnly}
          onChange={(next) => {
            setDraft({ ...draft, ...next });
          }}
        />
        <GrantsEditor
          value={draft.grants}
          readOnly={readOnly || locked}
          onChange={(grants) => {
            setDraft({ ...draft, grants });
          }}
        />
        {canManage ? (
          <div className="sticky bottom-0 flex items-center gap-2 border-t border-line bg-canvas py-3">
            <Button variant="primary" disabled={!dirty || saving} onClick={() => void save()}>
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
            {dirty ? (
              <span role="status" className="text-body-sm text-fg-secondary">
                {tc('unsaved')}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <DeleteDialog
        open={deleting}
        onOpenChange={setDeleting}
        name={data.name}
        path={`${base}/${id}`}
        inUse={inUse}
        onDeleted={() => {
          router.push(`/setup/${kind}`);
        }}
      />
    </>
  );
}
