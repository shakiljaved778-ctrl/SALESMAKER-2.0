'use client';

import { Banner, EmptyState, Input, Radio, RadioGroup, Skeleton, StatusChip } from '@sm/ui';
import { FileText, Search, SearchX } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { useShell } from '../shell/app-shell';
import { OBJECT_ICONS, sectionForObject, type DescribedObject } from './fields';
import {
  describesFor,
  hitDescription,
  readableObjects,
  searchRecords,
  SEARCH_DEBOUNCE_MS,
  type ObjectSummary,
  type SearchResult,
} from './search-client';

/** Hits per object on the "all objects" view, and on a single object's view (the API's cap). */
const PER_OBJECT_ALL = 10;
const PER_OBJECT_ONE = 50;
const DAY = 86_400_000;
const UPDATED = { any: 0, week: 7, month: 30, year: 365 } as const;
type Updated = keyof typeof UPDATED;
const UPDATED_LABEL = {
  any: 'updatedOptions.any',
  week: 'updatedOptions.week',
  month: 'updatedOptions.month',
  year: 'updatedOptions.year',
} as const;

/**
 * Search results (§7.19): every searchable object the viewer can read, grouped, typo-tolerant, with
 * facets for object (with counts), owner and last update. Filters live in the URL.
 */
export function SearchResults() {
  const t = useTranslations('records.search');
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { user } = useShell();
  const q = params.get('q') ?? '';
  const object = params.get('object') ?? '';
  const mine = params.get('owner') === 'me';
  const updatedParam = params.get('updated') ?? 'any';
  const updated: Updated = Object.hasOwn(UPDATED, updatedParam) ? (updatedParam as Updated) : 'any';
  const [text, setText] = useState(q);
  const [objects, setObjects] = useState<ObjectSummary[]>([]);
  const [totals, setTotals] = useState<SearchResult | null>(null);
  const [results, setResults] = useState<SearchResult | null>(null);
  const [describes, setDescribes] = useState<Map<string, DescribedObject>>(new Map());
  const [failed, setFailed] = useState(false);

  const set = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    router.replace(`${pathname}?${next.toString()}`);
  };

  useEffect(() => {
    void readableObjects().then(setObjects);
  }, []);

  // Typing refines the query in the URL (debounced), so results are shareable and survive reloads.
  useEffect(() => {
    if (text.trim() === q) return;
    const timer = setTimeout(() => {
      const next = new URLSearchParams(params.toString());
      if (text.trim()) next.set('q', text.trim());
      else next.delete('q');
      router.replace(`${pathname}?${next.toString()}`);
    }, SEARCH_DEBOUNCE_MS * 2);
    return () => {
      clearTimeout(timer);
    };
  }, [text, q, params, pathname, router]);

  useEffect(() => {
    if (!q) {
      setResults(null);
      setTotals(null);
      return;
    }
    const load = { cancelled: false };
    const shared = {
      q,
      ...(mine && user ? { ownerId: user.id } : {}),
      ...(UPDATED[updated]
        ? { updatedSince: new Date(Date.now() - UPDATED[updated] * DAY).toISOString() }
        : {}),
    };
    setResults(null);
    setFailed(false);
    void Promise.all([
      // Facet counts across every object, then the hits for the chosen one(s).
      searchRecords({ ...shared, limit: 1, totals: true }),
      searchRecords({
        ...shared,
        limit: object ? PER_OBJECT_ONE : PER_OBJECT_ALL,
        ...(object ? { objects: [object] } : {}),
      }),
    ]).then(async ([counts, hits]) => {
      const d = await describesFor(hits);
      if (load.cancelled) return;
      if (!hits) setFailed(true);
      setDescribes(d);
      setTotals(counts);
      setResults(hits);
    });
    return () => {
      load.cancelled = true;
    };
  }, [q, object, mine, updated, user]);

  const labelOf = (name: string) => objects.find((o) => o.name === name)?.labelPlural ?? name;
  const searchable = (totals?.groups ?? []).filter((g) => sectionForObject(g.object));
  const groups = (results?.groups ?? []).filter(
    (g) => g.hits.length > 0 && sectionForObject(g.object),
  );

  return (
    <div className="grid gap-4 p-[var(--page-padding)] lg:grid-cols-[16rem_1fr]">
      <div className="lg:col-span-2">
        <h1 className="mb-3 text-title-1 text-fg">
          {q ? t('titleFor', { query: q }) : t('title')}
        </h1>
        <div className="max-w-xl">
          <Input
            type="search"
            aria-label={t('query')}
            placeholder={t('query')}
            prefix={<Search aria-hidden />}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
            }}
          />
        </div>
      </div>

      <aside aria-label={t('filters')} className="grid content-start gap-5">
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-label text-fg-secondary">{t('object')}</legend>
          <RadioGroup
            value={object || 'all'}
            onValueChange={(v) => {
              set({ object: v === 'all' ? null : v });
            }}
          >
            <Radio value="all" label={t('allObjects')} />
            {searchable.map((g) => (
              <Radio
                key={g.object}
                value={g.object}
                label={`${labelOf(g.object)} (${String(g.total ?? g.hits.length)})`}
              />
            ))}
          </RadioGroup>
        </fieldset>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-label text-fg-secondary">{t('owner')}</legend>
          <RadioGroup
            value={mine ? 'me' : 'anyone'}
            onValueChange={(v) => {
              set({ owner: v === 'me' ? 'me' : null });
            }}
          >
            <Radio value="anyone" label={t('anyone')} />
            <Radio value="me" label={t('me')} />
          </RadioGroup>
        </fieldset>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-label text-fg-secondary">{t('updated')}</legend>
          <RadioGroup
            value={updated}
            onValueChange={(v) => {
              set({ updated: v === 'any' ? null : v });
            }}
          >
            {(Object.keys(UPDATED) as Updated[]).map((k) => (
              <Radio key={k} value={k} label={t(UPDATED_LABEL[k])} />
            ))}
          </RadioGroup>
        </fieldset>
      </aside>

      <section aria-label={t('results')} aria-live="polite" className="grid content-start gap-4">
        {!q ? (
          <EmptyState icon={<Search />} title={t('emptyTitle')} description={t('emptyBody')} />
        ) : failed ? (
          <Banner tone="danger" title={t('failed')}>
            {t('failedBody')}
          </Banner>
        ) : results === null ? (
          <Skeleton className="h-48 w-full" />
        ) : groups.length === 0 ? (
          <EmptyState icon={<SearchX />} title={t('noResults')} description={t('noResultsBody')} />
        ) : (
          groups.map((g) => {
            const Icon = OBJECT_ICONS[g.object] ?? FileText;
            const section = sectionForObject(g.object) ?? '';
            return (
              <section
                key={g.object}
                aria-label={labelOf(g.object)}
                className="rounded-md border border-line bg-surface shadow-e1"
              >
                <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
                  <Icon aria-hidden className="size-4 text-fg-secondary" />
                  <h2 className="text-title-3 text-fg">{labelOf(g.object)}</h2>
                  <StatusChip>{String(g.total ?? g.hits.length)}</StatusChip>
                  {!object && (g.total ?? 0) > g.hits.length ? (
                    <button
                      type="button"
                      className="ms-auto text-body-sm text-link underline-offset-4 hover:underline"
                      onClick={() => {
                        set({ object: g.object });
                      }}
                    >
                      {t('showAll', { objects: labelOf(g.object) })}
                    </button>
                  ) : null}
                </header>
                <ul className="divide-y divide-line-subtle">
                  {g.hits.map((h) => (
                    <li key={h.id} className="px-4 py-2.5 hover:bg-hover">
                      <Link
                        href={`/${section}/${h.id}`}
                        prefetch={false}
                        className="text-body-strong text-link underline-offset-4 hover:underline"
                      >
                        {h.name ?? h.id}
                      </Link>
                      {hitDescription(h, describes.get(g.object)) ? (
                        <p className="text-body-sm text-fg-secondary">
                          {hitDescription(h, describes.get(g.object))}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </section>
    </div>
  );
}
