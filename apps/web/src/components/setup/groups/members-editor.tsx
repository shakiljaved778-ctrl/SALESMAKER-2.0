'use client';

import type { MemberDto, PublicGroupDto } from '@sm/contracts';
import { Button, Combobox, IconButton, Select, StatusChip } from '@sm/ui';
import { Plus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { z } from 'zod';

import { useResource } from '../common';
import { UserPicker, useSetupOptions } from '../pickers';

export type Member = z.infer<typeof MemberDto>;
type MemberType = Member['type'];
type Group = z.infer<typeof PublicGroupDto>;

const TYPE_KEY = {
  USER: 'user',
  GROUP: 'group',
  ORG_UNIT: 'orgUnit',
  ORG_UNIT_AND_SUBORDINATES: 'orgUnitAndSubordinates',
} as const;

/**
 * The members of a public group or queue (§6.3): users, public groups, org units, and org units
 * with everything below them. `excludeGroup` keeps a group from being added to itself.
 */
export function MembersEditor({
  value,
  onChange,
  readOnly,
  excludeGroup,
}: {
  value: Member[];
  onChange: (next: Member[]) => void;
  readOnly?: boolean;
  excludeGroup?: string;
}) {
  const t = useTranslations('setup.members');
  const common = useTranslations('common');
  const { units } = useSetupOptions();
  const groups = useResource<{ items: Group[] }>('/v1/groups');
  const [type, setType] = useState<MemberType>('USER');
  const [candidate, setCandidate] = useState<{ id: string; name: string } | null>(null);

  const key = (m: { type: MemberType; id: string }) => `${m.type}:${m.id}`;
  const present = new Set(value.map(key));
  const add = () => {
    if (!candidate || present.has(key({ type, id: candidate.id }))) return;
    onChange([...value, { type, id: candidate.id, name: candidate.name }]);
    setCandidate(null);
  };
  const options =
    type === 'GROUP'
      ? (groups.data?.items ?? [])
          .filter((g) => g.id !== excludeGroup)
          .map((g) => ({ value: g.id, label: g.name }))
      : (units ?? []);
  const label = (id: string) => options.find((o) => o.value === id)?.label ?? '';

  return (
    <div className="flex flex-col gap-3">
      {value.length === 0 ? (
        <p className="text-body-sm text-fg-secondary">{t('none')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line-subtle rounded-md border border-line">
          {value.map((m) => (
            <li key={key(m)} className="flex items-center gap-3 px-3 py-2 text-body-sm">
              <StatusChip>{t(`types.${TYPE_KEY[m.type]}`)}</StatusChip>
              <span className="min-w-0 flex-1 truncate">{m.name}</span>
              {readOnly ? null : (
                <IconButton
                  label={t('remove', { name: m.name })}
                  size="sm"
                  onClick={() => {
                    onChange(value.filter((x) => key(x) !== key(m)));
                  }}
                >
                  <X />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {readOnly ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label={t('type')}
            value={type}
            onValueChange={(v) => {
              setType(v as MemberType);
              setCandidate(null);
            }}
            options={(Object.keys(TYPE_KEY) as MemberType[]).map((k) => ({
              value: k,
              label: t(`types.${TYPE_KEY[k]}`),
            }))}
            className="w-52"
          />
          <div className="w-72 max-w-full">
            {type === 'USER' ? (
              <UserPicker
                value={candidate?.id ?? null}
                placeholder={t('member')}
                onChange={(id, name) => {
                  setCandidate(id ? { id, name: name ?? '' } : null);
                }}
              />
            ) : (
              <Combobox
                options={options}
                loading={type === 'GROUP' ? groups.data === null : units === null}
                loadingText={common('states.loading')}
                value={candidate?.id ?? ''}
                onValueChange={(id) => {
                  setCandidate(id ? { id, name: label(id) } : null);
                }}
                placeholder={t('member')}
                searchPlaceholder={common('search.placeholder')}
                emptyText={common('search.noResults')}
              />
            )}
          </div>
          <Button icon={<Plus />} disabled={!candidate} onClick={add}>
            {t('add')}
          </Button>
        </div>
      )}
    </div>
  );
}
