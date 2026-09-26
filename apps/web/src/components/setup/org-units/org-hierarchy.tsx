'use client';

import type { OrgUnitDto } from '@sm/contracts';
import { Button, Combobox, Dialog, EmptyState, FormField, useToast } from '@sm/ui';
import { ChevronRight, Network, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { z } from 'zod';

import { cellApi } from '../../../lib/cell-api';
import { CreateDialog, DeleteDialog, NameFields, ResourceState, useResource } from '../common';
import { unitPaths } from '../pickers';
import { SetupHeader, useHasPermission } from '../setup-shell';
import { useSetupProblem } from '../use-problem';

type Unit = z.infer<typeof OrgUnitDto>;

interface Node {
  unit: Unit;
  depth: number;
  children: Node[];
}

function buildForest(units: Unit[]): Node[] {
  const byParent = new Map<string | null, Unit[]>();
  const ids = new Set(units.map((u) => u.id));
  for (const u of units) {
    const parent = u.parentId && ids.has(u.parentId) ? u.parentId : null;
    byParent.set(parent, [...(byParent.get(parent) ?? []), u]);
  }
  const build = (parent: string | null, depth: number): Node[] =>
    (byParent.get(parent) ?? [])
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((unit) => ({ unit, depth, children: build(unit.id, depth + 1) }));
  return build(null, 1);
}

/** Every unit in the subtree of `id` (itself included): it cannot become their child. */
function subtreeOf(forest: Node[], id: string): Set<string> {
  const out = new Set<string>();
  const walk = (nodes: Node[], inside: boolean) => {
    for (const n of nodes) {
      const here = inside || n.unit.id === id;
      if (here) out.add(n.unit.id);
      walk(n.children, here);
    }
  };
  walk(forest, false);
  return out;
}

/**
 * Setup → Org hierarchy (§6.3): an unlimited-depth tree. The tree follows the WAI-ARIA tree
 * pattern (arrows move and expand, Home/End jump, Enter selects); moving a branch is a dialog
 * with a parent picker, so it never needs a mouse.
 */
export function OrgHierarchy() {
  const t = useTranslations('setup.orgUnits');
  const tc = useTranslations('setup.common');
  const toast = useToast();
  const problem = useSetupProblem();
  const canManage = useHasPermission('manage_users');
  const { data, failure, reload } = useResource<{ items: Unit[] }>('/v1/org-units');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ parentId: string | null } | null>(null);
  const [moving, setMoving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [draft, setDraft] = useState<{ name: string; description: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const itemRefs = useRef(new Map<string, HTMLLIElement>());

  const units = useMemo(() => data?.items ?? [], [data]);
  const forest = useMemo(() => buildForest(units), [units]);
  const paths = useMemo(() => unitPaths(units), [units]);
  const unit = units.find((u) => u.id === selected) ?? null;

  // Open the first level once the tree arrives.
  useEffect(() => {
    if (!data) return;
    setExpanded((prev) => (prev.size ? prev : new Set(forest.map((n) => n.unit.id))));
  }, [data, forest]);
  useEffect(() => {
    setDraft(unit ? { name: unit.name, description: unit.description ?? '' } : null);
  }, [unit]);

  if (!data) return <ResourceState failure={failure} loading={!failure} />;

  const visible: Node[] = [];
  const collect = (nodes: Node[]) => {
    for (const n of nodes) {
      visible.push(n);
      if (expanded.has(n.unit.id)) collect(n.children);
    }
  };
  collect(forest);
  const parentOf = new Map(units.map((u) => [u.id, u.parentId]));
  const tabStop = focused ?? selected ?? visible[0]?.unit.id ?? null;

  const focus = (id: string | undefined) => {
    if (!id) return;
    setFocused(id);
    itemRefs.current.get(id)?.focus();
  };
  const toggle = (id: string, open?: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const onKey = (event: KeyboardEvent, node: Node) => {
    const i = visible.findIndex((n) => n.unit.id === node.unit.id);
    const rtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const key =
      rtl && event.key === 'ArrowRight'
        ? 'ArrowLeft'
        : rtl && event.key === 'ArrowLeft'
          ? 'ArrowRight'
          : event.key;
    const open = expanded.has(node.unit.id);
    switch (key) {
      case 'ArrowDown':
        focus(visible[i + 1]?.unit.id);
        break;
      case 'ArrowUp':
        focus(visible[i - 1]?.unit.id);
        break;
      case 'Home':
        focus(visible[0]?.unit.id);
        break;
      case 'End':
        focus(visible.at(-1)?.unit.id);
        break;
      case 'ArrowRight':
        if (node.children.length && !open) toggle(node.unit.id, true);
        else focus(node.children[0]?.unit.id);
        break;
      case 'ArrowLeft':
        if (node.children.length && open) toggle(node.unit.id, false);
        else focus(parentOf.get(node.unit.id) ?? undefined);
        break;
      case 'Enter':
      case ' ':
        setSelected(node.unit.id);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const renderNodes = (nodes: Node[]) =>
    nodes.map((node) => {
      const id = node.unit.id;
      const open = expanded.has(id);
      return (
        <li
          key={id}
          ref={(el) => {
            if (el) itemRefs.current.set(id, el);
            else itemRefs.current.delete(id);
          }}
          role="treeitem"
          aria-level={node.depth}
          aria-selected={selected === id}
          aria-expanded={node.children.length ? open : undefined}
          tabIndex={tabStop === id ? 0 : -1}
          onKeyDown={(e) => {
            if (e.target === e.currentTarget) onKey(e, node);
          }}
          onFocus={(e) => {
            if (e.target === e.currentTarget) setFocused(id);
          }}
          className="rounded-sm outline-offset-[-2px]"
        >
          <div
            className="flex h-8 cursor-pointer items-center gap-1 rounded-sm ps-1 pe-2 text-body-sm hover:bg-hover aria-[current=true]:bg-subtle aria-[current=true]:font-medium"
            aria-current={selected === id || undefined}
            onClick={() => {
              setSelected(id);
              setFocused(id);
            }}
          >
            {node.children.length ? (
              <button
                type="button"
                tabIndex={-1}
                aria-hidden="true"
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(id);
                }}
                className="flex size-5 items-center justify-center rounded-xs text-fg-secondary"
              >
                <ChevronRight
                  data-mirror=""
                  className={
                    open ? 'size-4 rotate-90 transition-transform' : 'size-4 transition-transform'
                  }
                />
              </button>
            ) : (
              <span className="size-5" aria-hidden="true" />
            )}
            <span className="truncate">{node.unit.name}</span>
            <span className="ms-auto text-caption tabular-nums text-fg-secondary">
              {node.unit.users}
            </span>
          </div>
          {node.children.length && open ? (
            <ul role="group" className="ps-4">
              {renderNodes(node.children)}
            </ul>
          ) : null}
        </li>
      );
    });

  const saveDetails = async () => {
    if (!unit || !draft) return;
    setSaving(true);
    const result = await cellApi<Unit>('PATCH', `/v1/org-units/${unit.id}`, {
      version: unit.version,
      name: draft.name.trim(),
      description: draft.description.trim() || null,
    });
    setSaving(false);
    if (!result.ok) {
      toast({ tone: 'error', title: problem(result) });
      return;
    }
    toast({ tone: 'success', title: tc('saved') });
    reload();
  };
  const dirty =
    unit && draft
      ? draft.name !== unit.name || draft.description !== (unit.description ?? '')
      : false;

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
                setCreating({ parentId: null });
              }}
            >
              {t('addRoot')}
            </Button>
          ) : null
        }
      />
      {units.length === 0 ? (
        <div className="p-[var(--page-padding)]">
          <EmptyState
            icon={<Network />}
            title={t('empty.title')}
            description={t('empty.description')}
          />
        </div>
      ) : (
        <div className="grid gap-6 p-[var(--page-padding)] lg:grid-cols-[minmax(18rem,26rem)_1fr]">
          <ul role="tree" aria-label={t('treeLabel')} className="flex flex-col gap-0.5">
            {renderNodes(forest)}
          </ul>
          <section aria-live="polite" className="flex flex-col gap-4">
            {unit && draft ? (
              <>
                <div className="flex flex-col gap-1">
                  <h2 className="text-title-3 text-fg">{unit.name}</h2>
                  <p className="text-body-sm text-fg-secondary">
                    {paths.get(unit.id)} · {t('userCount', { count: unit.users })}
                  </p>
                </div>
                <NameFields
                  name={draft.name}
                  description={draft.description}
                  readOnly={!canManage}
                  onChange={setDraft}
                />
                {canManage ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="primary"
                      disabled={!dirty || saving}
                      onClick={() => void saveDetails()}
                    >
                      {tc('saveChanges')}
                    </Button>
                    <Button
                      icon={<Plus />}
                      onClick={() => {
                        setCreating({ parentId: unit.id });
                      }}
                    >
                      {t('addChild')}
                    </Button>
                    <Button
                      onClick={() => {
                        setMoving(true);
                      }}
                    >
                      {t('move')}
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => {
                        setDeleting(true);
                      }}
                    >
                      {tc('delete')}
                    </Button>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-body-sm text-fg-secondary">{t('selectHint')}</p>
            )}
          </section>
        </div>
      )}
      {creating ? (
        <CreateDialog
          title={t('createTitle')}
          path="/v1/org-units"
          body={{ parentId: creating.parentId }}
          onClose={() => {
            setCreating(null);
          }}
          onCreated={(created) => {
            setCreating(null);
            if (created.parentId) toggle(created.parentId, true);
            setSelected(created.id);
            reload();
          }}
        />
      ) : null}
      {unit && moving ? (
        <MoveDialog
          unit={unit}
          options={units
            .filter((u) => !subtreeOf(forest, unit.id).has(u.id))
            .map((u) => ({ value: u.id, label: paths.get(u.id) ?? u.name }))
            .sort((a, b) => a.label.localeCompare(b.label))}
          onClose={(moved) => {
            setMoving(false);
            if (moved) reload();
          }}
        />
      ) : null}
      {unit ? (
        <DeleteDialog
          open={deleting}
          onOpenChange={setDeleting}
          name={unit.name}
          path={`/v1/org-units/${unit.id}`}
          inUse={t('notEmpty')}
          onDeleted={() => {
            setSelected(null);
            reload();
          }}
        />
      ) : null}
    </>
  );
}

function MoveDialog({
  unit,
  options,
  onClose,
}: {
  unit: Unit;
  options: { value: string; label: string }[];
  onClose: (moved: boolean) => void;
}) {
  const t = useTranslations('setup.orgUnits');
  const common = useTranslations('common');
  const toast = useToast();
  const problem = useSetupProblem();
  const [parentId, setParentId] = useState(unit.parentId ?? '');
  const [pending, setPending] = useState(false);
  const move = async () => {
    setPending(true);
    const result = await cellApi<Unit>('PATCH', `/v1/org-units/${unit.id}`, {
      version: unit.version,
      parentId: parentId || null,
    });
    setPending(false);
    if (!result.ok) {
      toast({ tone: 'error', title: problem(result, { conflict: t('cycle') }) });
      return;
    }
    toast({ tone: 'success', title: t('moved', { name: unit.name }) });
    onClose(true);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose(false);
      }}
      title={t('moveTitle', { name: unit.name })}
      description={t('moveBody')}
      closeLabel={common('actions.close')}
      footer={
        <>
          <Button
            onClick={() => {
              onClose(false);
            }}
          >
            {common('actions.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={pending || parentId === (unit.parentId ?? '')}
            onClick={() => void move()}
          >
            {t('move')}
          </Button>
        </>
      }
    >
      <FormField label={t('newParent')}>
        <Combobox
          options={[{ value: '', label: t('topLevel') }, ...options]}
          value={parentId}
          onValueChange={setParentId}
          placeholder={t('newParent')}
          searchPlaceholder={common('search.placeholder')}
          emptyText={common('search.noResults')}
        />
      </FormField>
    </Dialog>
  );
}
