'use client';

import type { FieldSettingDto, ObjectSummaryDto, RecordTypeDto } from '@sm/contracts';
import {
  Banner,
  Button,
  Dialog,
  EmptyState,
  FormField,
  Input,
  StatusChip,
  Tabs,
  useToast,
} from '@sm/ui';
import { Boxes, Plus } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState, type SyntheticEvent } from 'react';
import type { z } from 'zod';

import { cellApi } from '../../../lib/cell-api';
import type { DescribedObject } from '../../records/fields';
import { BackLink, ResourceState, useResource } from '../common';
import { SetupHeader, useHasPermission } from '../setup-shell';
import { useSetupProblem } from '../use-problem';
import { NewFieldWizard } from './new-field-wizard';
import { TYPE_LABEL, fieldLabel, toApiName } from './types';

type ObjectSummary = z.infer<typeof ObjectSummaryDto>;
export type FieldSetting = z.infer<typeof FieldSettingDto>;
type RecordType = z.infer<typeof RecordTypeDto>;

const th = 'px-3 py-2 text-start font-medium';
const td = 'px-3 py-2';

/** Setup → Object manager (§5): every object, standard and custom. */
export function ObjectsPage() {
  const t = useTranslations('setup.objects');
  const { data, failure } = useResource<{ items: ObjectSummary[] }>('/v1/objects');
  if (!data) return <ResourceState failure={failure} loading />;
  return (
    <>
      <SetupHeader title={t('title')} description={t('description')} />
      <div className="p-[var(--page-padding)]">
        <table className="w-full border-collapse text-body-sm">
          <thead>
            <tr className="border-b border-line text-caption text-fg-secondary">
              <th scope="col" className={th}>
                {t('label')}
              </th>
              <th scope="col" className={th}>
                {t('apiName')}
              </th>
              <th scope="col" className={th}>
                {t('kind')}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((o) => (
              <tr key={o.name} className="border-b border-line-subtle hover:bg-hover">
                <td className={td}>
                  <Link href={`/setup/objects/${o.name}`} className="font-medium text-link">
                    {o.label}
                  </Link>
                </td>
                <td className={`${td} font-mono text-fg-secondary`}>{o.name}</td>
                <td className={td}>
                  <StatusChip tone={o.custom ? 'info' : 'neutral'}>
                    {o.custom ? t('custom') : t('standard')}
                  </StatusChip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function FieldsTab({ object }: { object: string }) {
  const t = useTranslations('setup.objects');
  const canChange = useHasPermission('customize_application');
  const { data, failure, reload } = useResource<{ items: FieldSetting[] }>(
    `/v1/setup/objects/${object}/fields`,
  );
  const { data: described } = useResource<DescribedObject>(`/v1/objects/${object}/describe`);
  const labels = new Map((described?.fields ?? []).map((f) => [f.name, f.label]));
  const [creating, setCreating] = useState(false);
  if (!data) return <ResourceState failure={failure} loading />;
  const fields = [...data.items].sort((a, b) =>
    fieldLabel(a, labels).localeCompare(fieldLabel(b, labels)),
  );
  return (
    <div className="grid gap-3">
      {canChange ? (
        <Button
          variant="primary"
          icon={<Plus />}
          className="justify-self-end"
          onClick={() => {
            setCreating(true);
          }}
        >
          {t('newField')}
        </Button>
      ) : null}
      <table className="w-full border-collapse text-body-sm">
        <thead>
          <tr className="border-b border-line text-caption text-fg-secondary">
            <th scope="col" className={th}>
              {t('label')}
            </th>
            <th scope="col" className={th}>
              {t('apiName')}
            </th>
            <th scope="col" className={th}>
              {t('type')}
            </th>
            <th scope="col" className={th}>
              {t('attributes')}
            </th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => (
            <tr key={f.id} className="border-b border-line-subtle hover:bg-hover">
              <td className={td}>
                <Link
                  href={`/setup/objects/${object}/fields/${f.apiName}`}
                  className="font-medium text-link"
                >
                  {fieldLabel(f, labels)}
                </Link>
              </td>
              <td className={`${td} font-mono text-fg-secondary`}>{f.apiName}</td>
              <td className={`${td} text-fg-secondary`}>
                {Object.hasOwn(TYPE_LABEL, f.type)
                  ? t(TYPE_LABEL[f.type as keyof typeof TYPE_LABEL])
                  : f.type}
              </td>
              <td className={td}>
                <span className="flex flex-wrap gap-1">
                  {f.custom ? <StatusChip tone="info">{t('custom')}</StatusChip> : null}
                  {f.required ? <StatusChip>{t('required')}</StatusChip> : null}
                  {f.trackHistory ? <StatusChip>{t('tracked')}</StatusChip> : null}
                  {f.indexStatus ? (
                    <StatusChip tone={f.indexStatus === 'READY' ? 'success' : 'warning'}>
                      {t('indexed')}
                    </StatusChip>
                  ) : null}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {creating ? (
        <NewFieldWizard
          object={object}
          onClose={(created) => {
            setCreating(false);
            if (created) reload();
          }}
        />
      ) : null}
    </div>
  );
}

function RecordTypesTab({ object }: { object: string }) {
  const t = useTranslations('setup.objects');
  const tc = useTranslations('common.actions');
  const ts = useTranslations('setup.common');
  const toast = useToast();
  const problem = useSetupProblem();
  const canChange = useHasPermission('customize_application');
  const path = `/v1/setup/objects/${object}/record-types`;
  const { data, failure, reload } = useResource<{ items: RecordType[] }>(path);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [apiName, setApiName] = useState('');
  const [error, setError] = useState('');

  const change = async (rt: RecordType, body: Record<string, unknown>) => {
    const r = await cellApi('PATCH', `${path}/${rt.id}`, { version: rt.version, ...body });
    if (r.ok) {
      toast({ tone: 'success', title: ts('saved') });
      reload();
    } else toast({ tone: 'error', title: problem(r) });
  };
  const create = async (e: SyntheticEvent) => {
    e.preventDefault();
    const r = await cellApi('POST', path, { name: name.trim(), apiName });
    if (!r.ok) {
      setError(problem(r, { conflict: ts('nameTaken') }));
      return;
    }
    toast({ tone: 'success', title: ts('created', { name: name.trim() }) });
    setCreating(false);
    setName('');
    setApiName('');
    reload();
  };

  if (!data) return <ResourceState failure={failure} loading />;
  return (
    <div className="grid gap-3">
      {canChange ? (
        <Button
          variant="primary"
          icon={<Plus />}
          className="justify-self-end"
          onClick={() => {
            setCreating(true);
          }}
        >
          {t('newRecordType')}
        </Button>
      ) : null}
      <table className="w-full border-collapse text-body-sm">
        <thead>
          <tr className="border-b border-line text-caption text-fg-secondary">
            <th scope="col" className={th}>
              {t('label')}
            </th>
            <th scope="col" className={th}>
              {t('apiName')}
            </th>
            <th scope="col" className={th}>
              {t('status')}
            </th>
            {canChange ? (
              <th scope="col" className={th}>
                <span className="sr-only">{t('actions')}</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {data.items.map((rt) => (
            <tr key={rt.id} className="border-b border-line-subtle">
              <td className={`${td} font-medium text-fg`}>{rt.name}</td>
              <td className={`${td} font-mono text-fg-secondary`}>{rt.apiName}</td>
              <td className={td}>
                <span className="flex gap-1">
                  <StatusChip tone={rt.active ? 'success' : 'neutral'}>
                    {rt.active ? t('active') : t('inactive')}
                  </StatusChip>
                  {rt.isDefault ? <StatusChip tone="info">{t('default')}</StatusChip> : null}
                </span>
              </td>
              {canChange ? (
                <td className={`${td} text-end`}>
                  <span className="inline-flex gap-2">
                    {!rt.isDefault && rt.active ? (
                      <Button size="sm" onClick={() => void change(rt, { isDefault: true })}>
                        {t('makeDefault')}
                      </Button>
                    ) : null}
                    {!rt.isDefault ? (
                      <Button size="sm" onClick={() => void change(rt, { active: !rt.active })}>
                        {rt.active ? t('deactivate') : t('activate')}
                      </Button>
                    ) : null}
                  </span>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title={t('newRecordType')}
        closeLabel={tc('close')}
        footer={
          <>
            <Button
              onClick={() => {
                setCreating(false);
              }}
            >
              {tc('cancel')}
            </Button>
            <Button variant="primary" type="submit" form="new-record-type">
              {tc('save')}
            </Button>
          </>
        }
      >
        <form id="new-record-type" className="grid gap-4" onSubmit={(e) => void create(e)}>
          {error ? <Banner tone="danger">{error}</Banner> : null}
          <FormField label={t('label')} required>
            <Input
              value={name}
              maxLength={80}
              onChange={(e) => {
                setName(e.target.value);
                setApiName(toApiName(e.target.value, 40));
              }}
            />
          </FormField>
          <FormField label={t('apiName')} required helper={t('apiNameHelp')}>
            <Input
              value={apiName}
              dir="ltr"
              className="font-mono"
              onChange={(e) => {
                setApiName(e.target.value);
              }}
            />
          </FormField>
        </form>
      </Dialog>
    </div>
  );
}

/** One object in the Object manager: its fields and record types. */
export function ObjectDetailPage({ object }: { object: string }) {
  const t = useTranslations('setup.objects');
  const { data, failure } = useResource<{ items: ObjectSummary[] }>('/v1/objects');
  const [tab, setTab] = useState('fields');
  if (!data) return <ResourceState failure={failure} loading />;
  const summary = data.items.find((o) => o.name === object);
  if (!summary)
    return (
      <div className="p-[var(--page-padding)]">
        <EmptyState icon={<Boxes />} title={t('notFound')} description={t('notFoundBody')} />
      </div>
    );
  return (
    <>
      <SetupHeader
        title={summary.label}
        description={t('objectDescription', { name: summary.name })}
        breadcrumb={<BackLink href="/setup/objects">{t('title')}</BackLink>}
      />
      <div className="p-[var(--page-padding)]">
        <Tabs
          label={summary.label}
          value={tab}
          onValueChange={setTab}
          items={[
            { value: 'fields', label: t('fields'), content: <FieldsTab object={object} /> },
            {
              value: 'recordTypes',
              label: t('recordTypes'),
              content: <RecordTypesTab object={object} />,
            },
          ]}
        />
      </div>
    </>
  );
}
