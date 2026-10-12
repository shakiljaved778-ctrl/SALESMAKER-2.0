'use client';

import type { DuplicateGroupDto } from '@sm/contracts';
import { Banner, Button, Checkbox } from '@sm/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import type { z } from 'zod';

import { cellApi } from '../../lib/cell-api';
import type { DescribedObject } from '../records/fields';
import { MergeDialog } from './merge-dialog';
import { DEDUPE_OBJECTS } from './objects';

type Group = z.infer<typeof DuplicateGroupDto>;

/**
 * The record page's potential duplicates (§7.2): what the active duplicate rules find for this
 * record, visible records only. Nothing is shown when there are none. Up to two may be picked and
 * merged into this one (or it into them) with the merge dialog.
 */
export function PotentialDuplicates({
  object,
  id,
  section,
  describe,
  canMerge,
  onMerged,
}: {
  object: string;
  id: string;
  section: string;
  describe: DescribedObject;
  canMerge: boolean;
  /** After a merge: the record that survived. */
  onMerged: (survivorId: string) => void;
}) {
  const t = useTranslations('duplicates.panel');
  const [groups, setGroups] = useState<Group[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [merging, setMerging] = useState(false);

  useEffect(() => {
    if (!DEDUPE_OBJECTS.has(object)) return;
    void cellApi<{ groups: Group[] }>('GET', `/v1/records/${object}/${id}/duplicates`).then((r) => {
      if (r.ok) setGroups(r.data.groups);
    });
  }, [object, id]);

  // One entry per record, across rules, best score first.
  const matches = [
    ...new Map(
      groups
        .flatMap((g) => g.matches.map((m) => ({ ...m, rule: g.rule })))
        .sort((a, b) => b.score - a.score)
        .map((m) => [m.id, m]),
    ).values(),
  ];
  if (matches.length === 0) return null;

  return (
    <Banner tone="warning" title={t('title', { n: matches.length, object: describe.label })}>
      <ul className="mt-2 flex flex-col gap-1.5">
        {matches.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-2">
            {canMerge ? (
              <Checkbox
                aria-label={t('pick', { name: m.name ?? m.id })}
                checked={picked.includes(m.id)}
                disabled={!picked.includes(m.id) && picked.length >= 2}
                onCheckedChange={(checked) => {
                  setPicked((p) => (checked === true ? [...p, m.id] : p.filter((x) => x !== m.id)));
                }}
              />
            ) : null}
            <Link href={`/${section}/${m.id}`} className="text-link">
              {m.name ?? t('unnamed')}
            </Link>
            <span className="text-caption text-fg-secondary">
              {t('match', { rule: m.rule, score: Math.round(m.score * 100) })}
            </span>
          </li>
        ))}
      </ul>
      {canMerge ? (
        <div className="mt-3">
          <Button
            size="sm"
            variant="secondary"
            disabled={picked.length === 0}
            onClick={() => {
              setMerging(true);
            }}
          >
            {t('merge', { n: picked.length + 1 })}
          </Button>
        </div>
      ) : null}
      {merging ? (
        <MergeDialog
          object={object}
          describe={describe}
          ids={[id, ...picked]}
          open={merging}
          onOpenChange={setMerging}
          onMerged={(survivor) => {
            setPicked([]);
            setGroups([]);
            onMerged(survivor);
          }}
        />
      ) : null}
    </Banner>
  );
}
