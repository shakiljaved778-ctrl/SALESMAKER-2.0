'use client';

import { Banner, Skeleton } from '@sm/ui';
import { Building2, ChevronDown, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { cellApi } from '../../lib/cell-api';
import type { RecordRow } from './fields';

/** How far the tree reaches: parents up to the root, children this many levels down. */
const MAX_UP = 10;
const MAX_DOWN = 5;
const PER_LEVEL = 200;

interface Node {
  id: string;
  name: string;
  parentId: string | null;
}

const parentOf = (row: RecordRow): string | null => {
  const p = row['parent_account_id'];
  return p && typeof p === 'object' && 'id' in p && typeof p.id === 'string' ? p.id : null;
};
const nameOf = (row: RecordRow): string => (typeof row['name'] === 'string' ? row['name'] : row.id);

/**
 * Account hierarchy (§9.11 T2): the account's parents up to the root and every descendant the viewer
 * can see, as nested lists. Accounts the viewer cannot see are simply absent.
 */
export function AccountHierarchy({ accountId }: { accountId: string }) {
  const t = useTranslations('records.hierarchy');
  const [nodes, setNodes] = useState<Node[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    const load = { cancelled: false };
    void (async () => {
      const found = new Map<string, Node>();
      // Up: follow parent_account_id to the root.
      let id: string | null = accountId;
      let root = accountId;
      for (let i = 0; id && i < MAX_UP; i++) {
        const r = await cellApi<RecordRow>(
          'GET',
          `/v1/records/account/${id}?fields=name,parent_account_id`,
        );
        if (!r.ok) {
          if (i === 0) setFailed(true);
          break;
        }
        found.set(r.data.id, { id: r.data.id, name: nameOf(r.data), parentId: parentOf(r.data) });
        root = r.data.id;
        id = parentOf(r.data);
      }
      // Down: children of every account on the previous level.
      let level = [root];
      for (let depth = 0; level.length && depth < MAX_DOWN; depth++) {
        const r = await cellApi<{ items: RecordRow[] }>('POST', '/v1/query', {
          object: 'account',
          fields: ['name', 'parent_account_id'],
          where: { field: 'parent_account_id', op: 'in', value: level },
          orderBy: [{ field: 'name', direction: 'asc' }],
          limit: PER_LEVEL,
        });
        if (!r.ok) break;
        // Accounts already met on the way up still need their own children loaded.
        level = r.data.items.map((row) => row.id);
        for (const row of r.data.items)
          found.set(row.id, { id: row.id, name: nameOf(row), parentId: parentOf(row) });
      }
      if (!load.cancelled) setNodes([...found.values()]);
    })();
    return () => {
      load.cancelled = true;
    };
  }, [accountId]);

  if (failed) return <Banner tone="danger">{t('failed')}</Banner>;
  if (!nodes) return <Skeleton className="h-24 w-full" />;

  const children = new Map<string | null, Node[]>();
  for (const n of nodes) {
    const parent = n.parentId && nodes.some((x) => x.id === n.parentId) ? n.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), n]);
  }
  for (const list of children.values()) list.sort((a, b) => a.name.localeCompare(b.name));

  const toggle = (nodeId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  // Nested lists with disclosure buttons: plain links and buttons, so the keyboard just works.
  const render = (parent: string | null, top: boolean) => (
    <ul className={top ? 'grid gap-0.5' : 'grid gap-0.5 border-s border-line-subtle ms-2.5 ps-3'}>
      {(children.get(parent) ?? []).map((node) => {
        const kids = (children.get(node.id) ?? []).length > 0;
        const open = !collapsed.has(node.id);
        const current = node.id === accountId;
        return (
          <li key={node.id}>
            <div className="flex items-center gap-1 py-1">
              {kids ? (
                <button
                  type="button"
                  aria-expanded={open}
                  aria-label={
                    open ? t('collapse', { name: node.name }) : t('expand', { name: node.name })
                  }
                  className="grid size-5 place-items-center rounded-xs text-fg-secondary hover:bg-hover"
                  onClick={() => {
                    toggle(node.id);
                  }}
                >
                  {open ? (
                    <ChevronDown aria-hidden className="size-3.5" />
                  ) : (
                    <ChevronRight aria-hidden className="size-3.5 rtl:rotate-180" />
                  )}
                </button>
              ) : (
                <span className="size-5" />
              )}
              <Building2 aria-hidden className="size-4 text-fg-secondary" />
              <Link
                href={`/accounts/${node.id}`}
                prefetch={false}
                aria-current={current ? 'page' : undefined}
                className={
                  current
                    ? 'rounded-xs bg-selected px-1 text-body-strong text-link'
                    : 'rounded-xs px-1 text-body text-link underline-offset-4 hover:underline'
                }
              >
                {node.name}
              </Link>
            </div>
            {kids && open ? render(node.id, false) : null}
          </li>
        );
      })}
    </ul>
  );

  return <nav aria-label={t('label')}>{render(null, true)}</nav>;
}
