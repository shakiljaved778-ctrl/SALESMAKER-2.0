'use client';

import type { PageLayoutDto } from '@sm/contracts';
import {
  Banner,
  Button,
  Checkbox,
  FormField,
  IconButton,
  Input,
  Select,
  StatusChip,
  useToast,
} from '@sm/ui';
import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useState, type DragEvent } from 'react';
import type { z } from 'zod';

import { cellApi } from '../../../lib/cell-api';
import type { DescribedObject } from '../../records/fields';
import { BackLink, ResourceState, useResource } from '../common';
import { SetupHeader, useHasPermission } from '../setup-shell';
import { useSetupProblem } from '../use-problem';

export type Layout = z.infer<typeof PageLayoutDto>;
type Section = Layout['sections'][number];
type Slot = Section['fields'][number];

const th = 'px-3 py-2 text-start font-medium';

/** The standard section headings (`layouts.sections.*`), for sections without their own label. */
const STANDARD_SECTIONS = {
  'layouts.sections.details': 'details',
  'layouts.sections.address': 'address',
  'layouts.sections.description': 'description',
  'layouts.sections.system': 'system',
} as const;

/** Page layouts of an object (§5.4): which one is the default; open one to edit it. */
export function LayoutsTab({ object }: { object: string }) {
  const t = useTranslations('setup.layouts');
  const { data, failure } = useResource<{ items: Layout[] }>(`/v1/setup/objects/${object}/layouts`);
  if (!data) return <ResourceState failure={failure} loading />;
  return (
    <table className="w-full border-collapse text-body-sm">
      <thead>
        <tr className="border-b border-line text-caption text-fg-secondary">
          <th scope="col" className={th}>
            {t('name')}
          </th>
          <th scope="col" className={th}>
            {t('sections')}
          </th>
          <th scope="col" className={th}>
            {t('fields')}
          </th>
        </tr>
      </thead>
      <tbody>
        {data.items.map((l) => (
          <tr key={l.id} className="border-b border-line-subtle hover:bg-hover">
            <td className="px-3 py-2">
              <Link
                href={`/setup/objects/${object}/layouts/${l.id}`}
                className="font-medium text-link"
              >
                {l.name}
              </Link>{' '}
              {l.isDefault ? <StatusChip tone="info">{t('default')}</StatusChip> : null}
            </td>
            <td className="px-3 py-2 tabular-nums text-fg-secondary">{l.sections.length}</td>
            <td className="px-3 py-2 tabular-nums text-fg-secondary">
              {l.sections.reduce((n, s) => n + s.fields.length, 0)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Page layout editor (§5.4, §9.11 T5): sections with one or two columns; fields dragged within and
 * between sections, or moved with the buttons and the section picker (the keyboard path); per-field
 * required and read-only; fields added from those not yet placed.
 */
export function LayoutEditorPage({ object, id }: { object: string; id: string }) {
  const t = useTranslations('setup.layouts');
  const ts = useTranslations('setup.common');
  const tl = useTranslations('layouts.sections');
  const toast = useToast();
  const problem = useSetupProblem();
  const canChange = useHasPermission('customize_application');
  const { data, failure, reload } = useResource<{ items: Layout[] }>(
    `/v1/setup/objects/${object}/layouts`,
  );
  const { data: described } = useResource<DescribedObject>(`/v1/objects/${object}/describe`);
  const layout = data?.items.find((l) => l.id === id) ?? null;
  const [name, setName] = useState('');
  const [sections, setSections] = useState<Section[]>([]);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState<{ s: number; f: number } | null>(null);
  const [adding, setAdding] = useState('');

  useEffect(() => {
    if (!layout) return;
    setName(layout.name);
    setSections(layout.sections);
    setDirty(false);
  }, [layout]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
    };
  }, [dirty]);

  if (!data) return <ResourceState failure={failure} loading />;
  if (!layout)
    return (
      <div className="p-[var(--page-padding)]">
        <Banner tone="danger">{ts('notFound')}</Banner>
      </div>
    );

  const labels = new Map((described?.fields ?? []).map((f) => [f.name, f.label]));
  const headingOf = (s: Section, n: number) => {
    if (s.label) return s.label;
    const key = s.labelKey ?? '';
    return Object.hasOwn(STANDARD_SECTIONS, key)
      ? tl(STANDARD_SECTIONS[key as keyof typeof STANDARD_SECTIONS])
      : t('sectionN', { n });
  };
  const labelOf = (field: string) => labels.get(field) ?? field;
  const placed = new Set(sections.flatMap((s) => s.fields.map((f) => f.field)));
  const unplaced = (described?.fields ?? [])
    .filter((f) => !placed.has(f.name) && f.name !== 'id')
    .sort((a, b) => a.label.localeCompare(b.label));

  const edit = (next: Section[]) => {
    setSections(next);
    setDirty(true);
  };
  const updateSection = (i: number, change: Partial<Section>) => {
    edit(sections.map((s, j) => (j === i ? { ...s, ...change } : s)));
  };
  const moveSection = (i: number, by: -1 | 1) => {
    const next = [...sections];
    const [s] = next.splice(i, 1);
    if (s) next.splice(i + by, 0, s);
    edit(next);
  };
  /** Move a field to another section and position (before `toField`, or at the end). */
  const moveField = (from: { s: number; f: number }, to: { s: number; f: number | null }) => {
    const next = sections.map((s) => ({ ...s, fields: [...s.fields] }));
    const [slot] = next[from.s]?.fields.splice(from.f, 1) ?? [];
    if (!slot) return;
    const target = next[to.s];
    if (!target) return;
    let at = to.f ?? target.fields.length;
    if (from.s === to.s && to.f !== null && from.f < to.f) at -= 1;
    target.fields.splice(Math.max(0, at), 0, slot);
    edit(next);
  };
  const updateSlot = (s: number, f: number, change: Partial<Slot>) => {
    edit(
      sections.map((sec, i) =>
        i === s
          ? {
              ...sec,
              fields: sec.fields.map((slot, j) => (j === f ? { ...slot, ...change } : slot)),
            }
          : sec,
      ),
    );
  };
  const removeSlot = (s: number, f: number) => {
    edit(
      sections.map((sec, i) =>
        i === s ? { ...sec, fields: sec.fields.filter((_, j) => j !== f) } : sec,
      ),
    );
  };
  const addSection = () => {
    let n = sections.length + 1;
    while (sections.some((s) => s.key === `section_${String(n)}`)) n += 1;
    edit([
      ...sections,
      { key: `section_${String(n)}`, label: t('newSection'), columns: 2, fields: [] },
    ]);
  };

  const save = async () => {
    setSaving(true);
    setError('');
    const r = await cellApi('PATCH', `/v1/setup/objects/${object}/layouts/${id}`, {
      version: layout.version,
      name: name.trim(),
      sections,
    });
    setSaving(false);
    if (!r.ok) {
      setError(problem(r));
      return;
    }
    setDirty(false);
    toast({ tone: 'success', title: ts('saved') });
    reload();
  };

  const onDrop = (e: DragEvent, to: { s: number; f: number | null }) => {
    e.preventDefault();
    if (dragging) moveField(dragging, to);
    setDragging(null);
  };

  return (
    <>
      <SetupHeader
        title={layout.name}
        description={t('editorHelp')}
        breadcrumb={<BackLink href={`/setup/objects/${object}`}>{t('back')}</BackLink>}
        actions={
          canChange ? (
            <Button
              variant="primary"
              loading={saving}
              disabled={!dirty}
              onClick={() => void save()}
            >
              {ts('saveChanges')}
            </Button>
          ) : null
        }
      />
      <div className="grid max-w-5xl gap-5 p-[var(--page-padding)]">
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
          <FormField label={t('name')}>
            <Input
              value={name}
              maxLength={80}
              disabled={!canChange}
              onChange={(e) => {
                setName(e.target.value);
                setDirty(true);
              }}
            />
          </FormField>
          {canChange && unplaced.length ? (
            <div className="flex items-end gap-2">
              <div className="w-64">
                <FormField label={t('addField')}>
                  <Select
                    placeholder={t('chooseField')}
                    options={unplaced.map((f) => ({ value: f.name, label: f.label }))}
                    {...(adding ? { value: adding } : {})}
                    onValueChange={setAdding}
                  />
                </FormField>
              </div>
              <Button
                icon={<Plus />}
                disabled={!adding || sections.length === 0}
                onClick={() => {
                  const [first, ...rest] = sections;
                  if (!first) return;
                  edit([{ ...first, fields: [...first.fields, { field: adding }] }, ...rest]);
                  setAdding('');
                }}
              >
                {t('add')}
              </Button>
            </div>
          ) : null}
        </div>

        {sections.map((section, si) => (
          <section
            key={section.key}
            aria-label={headingOf(section, si + 1)}
            className="rounded-md border border-line bg-surface shadow-e1"
            onDragOver={(e) => {
              e.preventDefault();
            }}
            onDrop={(e) => {
              onDrop(e, { s: si, f: null });
            }}
          >
            <header className="flex flex-wrap items-end gap-3 border-b border-line px-4 py-3">
              <div className="min-w-48 flex-1">
                <FormField label={t('sectionLabel')}>
                  <Input
                    value={section.label ?? ''}
                    placeholder={
                      section.labelKey
                        ? headingOf({ ...section, label: null }, si + 1)
                        : t('untitled')
                    }
                    maxLength={80}
                    disabled={!canChange}
                    onChange={(e) => {
                      updateSection(si, { label: e.target.value || null });
                    }}
                  />
                </FormField>
              </div>
              <div className="w-40">
                <FormField label={t('columns')}>
                  <Select
                    disabled={!canChange}
                    options={[
                      { value: '1', label: t('oneColumn') },
                      { value: '2', label: t('twoColumns') },
                    ]}
                    value={String(section.columns)}
                    onValueChange={(v) => {
                      updateSection(si, { columns: v === '1' ? 1 : 2 });
                    }}
                  />
                </FormField>
              </div>
              {canChange ? (
                <span className="flex gap-1">
                  <IconButton
                    label={t('moveSectionUp')}
                    variant="ghost"
                    disabled={si === 0}
                    onClick={() => {
                      moveSection(si, -1);
                    }}
                  >
                    <ArrowUp />
                  </IconButton>
                  <IconButton
                    label={t('moveSectionDown')}
                    variant="ghost"
                    disabled={si === sections.length - 1}
                    onClick={() => {
                      moveSection(si, 1);
                    }}
                  >
                    <ArrowDown />
                  </IconButton>
                  <IconButton
                    label={t('removeSection')}
                    variant="ghost"
                    disabled={sections.length === 1 || section.fields.length > 0}
                    onClick={() => {
                      edit(sections.filter((_, j) => j !== si));
                    }}
                  >
                    <Trash2 />
                  </IconButton>
                </span>
              ) : null}
            </header>
            {section.fields.length === 0 ? (
              <p className="px-4 py-6 text-center text-body-sm text-fg-secondary">
                {t('emptySection')}
              </p>
            ) : (
              <ul className="divide-y divide-line-subtle">
                {section.fields.map((slot, fi) => (
                  <li
                    key={slot.field}
                    draggable={canChange}
                    onDragStart={() => {
                      setDragging({ s: si, f: fi });
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onDrop={(e) => {
                      e.stopPropagation();
                      onDrop(e, { s: si, f: fi });
                    }}
                    className="flex flex-wrap items-center gap-3 px-4 py-2 data-[dragging=true]:opacity-50"
                    data-dragging={dragging?.s === si && dragging.f === fi}
                  >
                    {canChange ? (
                      <GripVertical aria-hidden className="size-4 cursor-grab text-fg-tertiary" />
                    ) : null}
                    <span className="min-w-40 flex-1 text-body text-fg">{labelOf(slot.field)}</span>
                    <Checkbox
                      label={t('required')}
                      checked={Boolean(slot.required)}
                      disabled={!canChange}
                      onCheckedChange={(c) => {
                        updateSlot(si, fi, { required: c === true });
                      }}
                    />
                    <Checkbox
                      label={t('readOnly')}
                      checked={Boolean(slot.readOnly)}
                      disabled={!canChange}
                      onCheckedChange={(c) => {
                        updateSlot(si, fi, { readOnly: c === true });
                      }}
                    />
                    {canChange ? (
                      <span className="flex items-center gap-1">
                        {sections.length > 1 ? (
                          <div className="w-44">
                            <Select
                              aria-label={t('moveTo', { field: labelOf(slot.field) })}
                              options={sections.map((s, j) => ({
                                value: String(j),
                                label: headingOf(s, j + 1),
                              }))}
                              value={String(si)}
                              onValueChange={(v) => {
                                if (Number(v) !== si)
                                  moveField({ s: si, f: fi }, { s: Number(v), f: null });
                              }}
                            />
                          </div>
                        ) : null}
                        <IconButton
                          label={t('moveUp', { field: labelOf(slot.field) })}
                          size="sm"
                          variant="ghost"
                          disabled={fi === 0}
                          onClick={() => {
                            moveField({ s: si, f: fi }, { s: si, f: fi - 1 });
                          }}
                        >
                          <ArrowUp />
                        </IconButton>
                        <IconButton
                          label={t('moveDown', { field: labelOf(slot.field) })}
                          size="sm"
                          variant="ghost"
                          disabled={fi === section.fields.length - 1}
                          onClick={() => {
                            moveField({ s: si, f: fi }, { s: si, f: fi + 2 });
                          }}
                        >
                          <ArrowDown />
                        </IconButton>
                        <IconButton
                          label={t('remove', { field: labelOf(slot.field) })}
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            removeSlot(si, fi);
                          }}
                        >
                          <Trash2 />
                        </IconButton>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
        {canChange ? (
          <Button icon={<Plus />} className="justify-self-start" onClick={addSection}>
            {t('addSection')}
          </Button>
        ) : null}
      </div>
    </>
  );
}
