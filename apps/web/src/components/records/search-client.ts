'use client';

import type { ObjectSummaryDto, SearchHitDto, SearchResultDto } from '@sm/contracts';
import type { z } from 'zod';

import { cellApi } from '../../lib/cell-api';
import type { DescribedObject } from './fields';

export type SearchResult = z.infer<typeof SearchResultDto>;
export type SearchHit = z.infer<typeof SearchHitDto>;
export type ObjectSummary = z.infer<typeof ObjectSummaryDto>;

/** Search as the user types: debounce, and drop answers to queries they have moved past. */
export const SEARCH_DEBOUNCE_MS = 150;

let objectsCache: Promise<ObjectSummary[]> | null = null;

/** The objects the caller can read (labels for result groups), fetched once per page. */
export function readableObjects(): Promise<ObjectSummary[]> {
  objectsCache ??= cellApi<{ items: ObjectSummary[] }>('GET', '/v1/objects').then((r) =>
    r.ok ? r.data.items : [],
  );
  return objectsCache;
}

const describeCache = new Map<string, Promise<DescribedObject | null>>();

/** An object's describe, fetched once per page (picklist labels for result lines). */
export function describeObject(object: string): Promise<DescribedObject | null> {
  let hit = describeCache.get(object);
  if (!hit) {
    hit = cellApi<DescribedObject>('GET', `/v1/objects/${object}/describe`).then((r) =>
      r.ok ? r.data : null,
    );
    describeCache.set(object, hit);
  }
  return hit;
}

/** Describes for every object in a result, keyed by object. */
export async function describesFor(
  result: SearchResult | null,
): Promise<Map<string, DescribedObject>> {
  const out = new Map<string, DescribedObject>();
  for (const g of result?.groups ?? []) {
    const d = await describeObject(g.object);
    if (d) out.set(g.object, d);
  }
  return out;
}

export interface SearchParams {
  q: string;
  objects?: string[];
  limit?: number;
  ownerId?: string;
  updatedSince?: string;
  totals?: boolean;
}

export async function searchRecords(params: SearchParams): Promise<SearchResult | null> {
  const q = new URLSearchParams({ q: params.q });
  if (params.objects?.length) q.set('objects', params.objects.join(','));
  if (params.limit) q.set('limit', String(params.limit));
  if (params.ownerId) q.set('ownerId', params.ownerId);
  if (params.updatedSince) q.set('updatedSince', params.updatedSince);
  if (params.totals) q.set('totals', 'true');
  const r = await cellApi<SearchResult>('GET', `/v1/search?${q.toString()}`);
  return r.ok ? r.data : null;
}

const textOf = (v: unknown): string | null => {
  if (typeof v === 'string' && v.trim()) return v;
  if (v && typeof v === 'object' && 'name' in v && typeof v.name === 'string') return v.name;
  return null;
};

/**
 * A hit's secondary line: its display fields other than the name (company, account, email…), with
 * picklist values shown by their labels when the object's describe is at hand.
 */
export function hitDescription(hit: SearchHit, describe?: DescribedObject): string {
  const name = hit.name ?? '';
  return Object.entries(hit.record)
    .filter(([k]) => k !== 'id' && k !== 'version')
    .map(([k, v]) => {
      const options = describe?.fields.find((f) => f.name === k)?.picklistValues;
      const label = options?.find((o) => o.value === v)?.label;
      return label ?? textOf(v);
    })
    .filter((v): v is string => v !== null && !name.includes(v))
    .slice(0, 2)
    .join(' · ');
}
