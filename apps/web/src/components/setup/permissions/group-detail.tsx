'use client';

import type { PermissionSetGroupDetail, PermissionSetSummary } from '@sm/contracts';
import { Banner, Button, Checkbox, useToast } from '@sm/ui';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import type { z } from 'zod';

import { cellApi } from '../../../lib/cell-api';
import { BackLink, DeleteDialog, NameFields, ResourceState, useResource } from '../common';
import { EMPTY_GRANTS, GrantsEditor, type Grants } from '../grants-editor';
import { SetupHeader, useHasPermission } from '../setup-shell';
import { useSetupProblem } from '../use-problem';

type Group = z.infer<typeof PermissionSetGroupDetail>;
type PermissionSet = z.infer<typeof PermissionSetSummary>;

interface Draft {
  name: string;
  description: string;
  setIds: string[];
  muting: Grants | null;
}

const draftOf = (g: Group): Draft => ({
  name: g.name,
  description: g.description ?? '',
  setIds: g.permissionSets.map((s) => s.id).sort(),
  muting: g.muting,
});

/** A permission set group (§6.2): its sets, and a muting set that removes from them only. */
export function PermissionSetGroupDetailView({ id }: { id: string }) {
  const t = useTranslations('setup.permissionSetGroups');
  const tc = useTranslations('setup.common');
  const tg = useTranslations('setup.grants');
  const common = useTranslations('common');
  const toast = useToast();
  const router = useRouter();
  const problem = useSetupProblem();
  const canManage = useHasPermission('manage_users');
  const { data, failure, replace } = useResource<Group>(`/v1/permission-set-groups/${id}`);
  const sets = useResource<{ items: PermissionSet[] }>('/v1/permission-sets');
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
    const result = await cellApi<Group>('PATCH', `/v1/permission-set-groups/${id}`, {
      version: data.version,
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      permissionSetIds: draft.setIds,
      muting: draft.muting,
    });
    setSaving(false);
    if (!result.ok) {
      toast({ tone: 'error', title: problem(result, { conflict: tc('nameTaken') }) });
      return;
    }
    replace(result.data);
    toast({ tone: 'success', title: tc('saved') });
  };

  return (
    <>
      <SetupHeader
        breadcrumb={<BackLink href="/setup/permission-set-groups">{t('title')}</BackLink>}
        title={data.name}
        {...(data.description ? { description: data.description } : {})}
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
      <div className="flex max-w-5xl flex-col gap-6 p-[var(--page-padding)]">
        {readOnly ? <Banner tone="info">{tg('readOnlyNote')}</Banner> : null}
        <NameFields
          name={draft.name}
          description={draft.description}
          readOnly={readOnly}
          onChange={(next) => {
            setDraft({ ...draft, ...next });
          }}
        />
        <fieldset className="flex flex-col gap-2" disabled={readOnly}>
          <legend className="pb-2 text-title-3 text-fg">{t('sets')}</legend>
          {sets.data === null ? (
            <ResourceState failure={sets.failure} loading={!sets.failure} />
          ) : sets.data.items.length === 0 ? (
            <p className="text-body-sm text-fg-secondary">{t('noSets')}</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {sets.data.items.map((s) => (
                <Checkbox
                  key={s.id}
                  label={s.name}
                  checked={draft.setIds.includes(s.id)}
                  disabled={readOnly}
                  onCheckedChange={(c) => {
                    const rest = draft.setIds.filter((x) => x !== s.id);
                    setDraft({ ...draft, setIds: c === true ? [...rest, s.id].sort() : rest });
                  }}
                />
              ))}
            </div>
          )}
        </fieldset>
        <section className="flex flex-col gap-3" aria-labelledby="muting-heading">
          <div className="flex items-center justify-between gap-4">
            <h2 id="muting-heading" className="text-title-3 text-fg">
              {t('muting')}
            </h2>
            {canManage ? (
              <Button
                size="sm"
                onClick={() => {
                  setDraft({ ...draft, muting: draft.muting ? null : EMPTY_GRANTS });
                }}
              >
                {draft.muting ? t('removeMuting') : t('addMuting')}
              </Button>
            ) : null}
          </div>
          <p className="text-body-sm text-fg-secondary">{t('mutingHelp')}</p>
          {draft.muting ? (
            <GrantsEditor
              value={draft.muting}
              mode="muting"
              readOnly={readOnly}
              onChange={(muting) => {
                setDraft({ ...draft, muting });
              }}
            />
          ) : null}
        </section>
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
          </div>
        ) : null}
      </div>
      <DeleteDialog
        open={deleting}
        onOpenChange={setDeleting}
        name={data.name}
        path={`/v1/permission-set-groups/${id}`}
        inUse={t('inUse')}
        onDeleted={() => {
          router.push('/setup/permission-set-groups');
        }}
      />
    </>
  );
}
