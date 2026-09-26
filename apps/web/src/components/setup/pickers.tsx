'use client';

import type { OrgUnitDto, ProfileSummary, UserSummary } from '@sm/contracts';
import { Combobox, type ComboboxOption } from '@sm/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import type { z } from 'zod';

import { cellApi, query } from '../../lib/cell-api';

type OrgUnit = z.infer<typeof OrgUnitDto>;

/** "Company › Sales › East": each unit's path from the root, for pickers and lists. */
export function unitPaths(units: readonly OrgUnit[]): Map<string, string> {
  const byId = new Map(units.map((u) => [u.id, u]));
  const paths = new Map<string, string>();
  for (const unit of units) {
    const names: string[] = [];
    const seen = new Set<string>();
    for (let u: OrgUnit | undefined = unit; u && !seen.has(u.id); u = byId.get(u.parentId ?? '')) {
      seen.add(u.id);
      names.unshift(u.name);
    }
    paths.set(unit.id, names.join(' › '));
  }
  return paths;
}

/** Profiles and org units as picker options, loaded once per page. */
export function useSetupOptions() {
  const [profiles, setProfiles] = useState<ComboboxOption[] | null>(null);
  const [units, setUnits] = useState<ComboboxOption[] | null>(null);
  useEffect(() => {
    void cellApi<{ items: z.infer<typeof ProfileSummary>[] }>('GET', '/v1/profiles').then((r) => {
      setProfiles(r.ok ? r.data.items.map((p) => ({ value: p.id, label: p.name })) : []);
    });
    void cellApi<{ items: OrgUnit[] }>('GET', '/v1/org-units').then((r) => {
      if (!r.ok) {
        setUnits([]);
        return;
      }
      const paths = unitPaths(r.data.items);
      setUnits(
        r.data.items
          .map((u) => ({ value: u.id, label: paths.get(u.id) ?? u.name }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      );
    });
  }, []);
  return { profiles, units };
}

/** Pick a user by searching names and emails (managers, members). */
export function UserPicker({
  value,
  initial,
  onChange,
  placeholder,
  exclude,
}: {
  value: string | null;
  initial?: { id: string; name: string } | null;
  onChange: (id: string | null, name?: string) => void;
  placeholder: string;
  exclude?: string;
}) {
  const t = useTranslations('common');
  const tc = useTranslations('setup.common');
  const [options, setOptions] = useState<ComboboxOption[]>(
    initial ? [{ value: initial.id, label: initial.name }] : [],
  );
  const [loading, setLoading] = useState(false);
  const search = useCallback(
    (q: string) => {
      setLoading(true);
      void cellApi<{ items: z.infer<typeof UserSummary>[] }>(
        'GET',
        `/v1/users${query({ q: q.trim(), limit: 20 })}`,
      ).then((r) => {
        setLoading(false);
        if (!r.ok) return;
        setOptions(
          r.data.items
            .filter((u) => u.id !== exclude && !u.deactivated)
            .map((u) => ({ value: u.id, label: u.name, description: u.email })),
        );
      });
    },
    [exclude],
  );
  useEffect(() => {
    search('');
  }, [search]);
  return (
    <Combobox
      options={[{ value: '', label: tc('none') }, ...options]}
      value={value ?? ''}
      onValueChange={(v) => {
        onChange(v || null, options.find((o) => o.value === v)?.label);
      }}
      onSearch={search}
      loading={loading}
      loadingText={t('states.loading')}
      placeholder={placeholder}
      searchPlaceholder={t('search.placeholder')}
      emptyText={t('search.noResults')}
    />
  );
}
