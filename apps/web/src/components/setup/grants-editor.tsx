'use client';

import type { GrantsDto } from '@sm/contracts';
import { camelCase, flsFields, STANDARD_OBJECTS } from '@sm/metadata';
import { SYSTEM_PERMISSIONS, systemPermissionLabelKey, type ObjectAccess } from '@sm/permissions';
import { Checkbox, Select, Tabs } from '@sm/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { z } from 'zod';

import { FLAGS, toggleObjectFlag } from '../../lib/grants';

export type Grants = z.infer<typeof GrantsDto>;

/** A copy of `record` without `key`. */
function without<V>(record: Partial<Record<string, V>>, key: string): Partial<Record<string, V>> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}
export const EMPTY_GRANTS: Grants = { system: [], objects: {}, fields: {} };

const NONE: ObjectAccess = {
  read: false,
  create: false,
  edit: false,
  delete: false,
  viewAll: false,
  modifyAll: false,
};

/**
 * The grants of a profile, permission set or muting set (§6.2): system permissions, the object
 * permission matrix and field-level security per object. Controlled: the parent owns `value`.
 */
export function GrantsEditor({
  value,
  onChange,
  mode = 'grant',
  readOnly = false,
}: {
  value: Grants;
  onChange: (next: Grants) => void;
  mode?: 'grant' | 'muting';
  readOnly?: boolean;
}) {
  const t = useTranslations('setup.grants');
  const tAll = useTranslations();
  const [object, setObject] = useState<string>(STANDARD_OBJECTS[0]?.apiName ?? 'lead');
  const objectLabel = (apiName: string) =>
    tAll(`objects.${camelCase(apiName)}.plural` as Parameters<typeof tAll>[0]);

  const system = (
    <fieldset className="grid gap-2 sm:grid-cols-2" disabled={readOnly}>
      <legend className="sr-only">{t('system')}</legend>
      {SYSTEM_PERMISSIONS.map((name) => (
        <Checkbox
          key={name}
          label={tAll(systemPermissionLabelKey(name) as Parameters<typeof tAll>[0])}
          checked={value.system.includes(name)}
          disabled={readOnly}
          onCheckedChange={(checked) => {
            const rest = value.system.filter((s) => s !== name);
            onChange({ ...value, system: checked === true ? [...rest, name].sort() : rest });
          }}
        />
      ))}
    </fieldset>
  );

  const objects = (
    <div className="flex flex-col gap-2">
      <p className="text-body-sm text-fg-secondary">
        {mode === 'muting' ? t('mutingNote') : t('dependencyNote')}
      </p>
      <table className="w-full border-collapse text-body-sm">
        <thead>
          <tr className="border-b border-line text-caption text-fg-secondary">
            <th scope="col" className="px-3 py-2 text-start font-medium">
              {t('object')}
            </th>
            {FLAGS.map((f) => (
              <th key={f} scope="col" className="px-2 py-2 text-center font-medium">
                {t(f)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {STANDARD_OBJECTS.map((o) => {
            const access = value.objects[o.apiName] ?? NONE;
            return (
              <tr key={o.apiName} className="border-b border-line-subtle">
                <th scope="row" className="px-3 py-1.5 text-start font-normal text-fg">
                  {objectLabel(o.apiName)}
                </th>
                {FLAGS.map((f) => (
                  <td key={f} className="px-2 py-1.5 text-center">
                    <Checkbox
                      aria-label={`${objectLabel(o.apiName)}: ${t(f)}`}
                      checked={access[f]}
                      disabled={readOnly}
                      onCheckedChange={(checked) => {
                        const next = toggleObjectFlag(access, f, checked === true, mode);
                        const objectsNext = FLAGS.some((k) => next[k])
                          ? { ...value.objects, [o.apiName]: next }
                          : without(value.objects, o.apiName);
                        onChange({ ...value, objects: objectsNext as Grants['objects'] });
                      }}
                    />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  const fieldsOf = flsFields(object);
  const fields = (
    <div className="flex flex-col gap-3">
      <Select
        aria-label={t('chooseObject')}
        value={object}
        onValueChange={setObject}
        options={STANDARD_OBJECTS.map((o) => ({ value: o.apiName, label: objectLabel(o.apiName) }))}
        className="w-60"
      />
      {fieldsOf.length === 0 ? (
        <p className="text-body-sm text-fg-secondary">{t('noFields')}</p>
      ) : (
        <table className="w-full max-w-xl border-collapse text-body-sm">
          <thead>
            <tr className="border-b border-line text-caption text-fg-secondary">
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t('field')}
              </th>
              <th scope="col" className="px-2 py-2 text-center font-medium">
                {t('read')}
              </th>
              <th scope="col" className="px-2 py-2 text-center font-medium">
                {t('edit')}
              </th>
            </tr>
          </thead>
          <tbody>
            {fieldsOf.map((field) => {
              const access = value.fields[object]?.[field.apiName] ?? { read: false, edit: false };
              const label = tAll(field.labelKey as Parameters<typeof tAll>[0]);
              const set = (next: { read: boolean; edit: boolean }) => {
                const current = value.fields[object] ?? {};
                const byField =
                  next.read || next.edit
                    ? { ...current, [field.apiName]: next }
                    : without(current, field.apiName);
                const fieldsNext = Object.keys(byField).length
                  ? { ...value.fields, [object]: byField }
                  : without(value.fields, object);
                onChange({ ...value, fields: fieldsNext as Grants['fields'] });
              };
              return (
                <tr key={field.apiName} className="border-b border-line-subtle">
                  <th scope="row" className="px-3 py-1.5 text-start font-normal text-fg">
                    {label}
                  </th>
                  <td className="px-2 py-1.5 text-center">
                    <Checkbox
                      aria-label={`${label}: ${t('read')}`}
                      checked={access.read}
                      disabled={readOnly}
                      onCheckedChange={(c) => {
                        const read = c === true;
                        set(
                          mode === 'muting'
                            ? { ...access, read }
                            : { read, edit: read && access.edit },
                        );
                      }}
                    />
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    <Checkbox
                      aria-label={`${label}: ${t('edit')}`}
                      checked={access.edit}
                      disabled={readOnly}
                      onCheckedChange={(c) => {
                        const edit = c === true;
                        set(
                          mode === 'muting'
                            ? { ...access, edit }
                            : { read: access.read || edit, edit },
                        );
                      }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );

  return (
    <Tabs
      label={t('label')}
      items={[
        { value: 'system', label: t('system'), content: system },
        { value: 'objects', label: t('objects'), content: objects },
        { value: 'fields', label: t('fields'), content: fields },
      ]}
    />
  );
}
