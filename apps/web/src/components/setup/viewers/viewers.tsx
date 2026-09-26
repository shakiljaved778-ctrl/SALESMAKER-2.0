'use client';

import {
  AuditLogEntry,
  LoginHistoryEntry,
  SetupAuditEntry,
  type AuditChainStatus,
  type UserDetail,
} from '@sm/contracts';
import { camelCase, STANDARD_OBJECTS } from '@sm/metadata';
import { Banner, Button, EmptyState, Input, Select, Skeleton, StatusChip } from '@sm/ui';
import { ListFilter } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { z } from 'zod';

import type { ApiResult } from '../../../lib/client-api';
import { cellApi, query } from '../../../lib/cell-api';
import { useResource } from '../common';
import { UserPicker } from '../pickers';
import { SetupHeader } from '../setup-shell';
import { useSetupProblem } from '../use-problem';

type Params = Record<string, string | null | undefined>;

/** A keyset-paged list (§10.1) that reloads from the start whenever its filters change. */
function usePaged<S extends z.ZodType>(path: string, params: Params, item: S) {
  type T = z.infer<S>;
  const [items, setItems] = useState<T[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiResult<unknown> | null>(null);
  const key = JSON.stringify(params);
  const load = useCallback(
    async (after: string | null) => {
      const filters = JSON.parse(key) as Params;
      const result = await cellApi<{ items: unknown[]; nextCursor: string | null }>(
        'GET',
        `${path}${query({ ...filters, cursor: after, limit: 50 })}`,
      );
      if (!result.ok) {
        setFailure(result);
        return;
      }
      setFailure(null);
      const page = result.data.items.map((i) => item.parse(i));
      setItems((prev) => (after && prev ? [...prev, ...page] : page));
      setCursor(result.data.nextCursor);
    },
    [path, key, item],
  );
  useEffect(() => {
    setItems(null);
    void load(null);
  }, [load]);
  return {
    items,
    failure,
    more: cursor
      ? () => {
          void load(cursor);
        }
      : null,
  };
}

/** Display names for user ids, fetched once per page load and shared between viewers. */
const nameCache = new Map<string, string | null>();
function useUserNames(ids: readonly (string | null)[]): (id: string | null) => string | undefined {
  const [, bump] = useState(0);
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))]
    .filter((id) => !nameCache.has(id))
    .sort()
    .join(',');
  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    void Promise.all(
      wanted.split(',').map(async (id) => {
        const r = await cellApi<z.infer<typeof UserDetail>>('GET', `/v1/users/${id}`);
        nameCache.set(id, r.ok ? r.data.name : null);
      }),
    ).then(() => {
      if (!cancelled) bump((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [wanted]);
  return (id) => {
    if (!id) return undefined;
    const name = nameCache.get(id);
    return name === null ? '' : name;
  };
}

function When({ at }: { at: string }) {
  const format = useFormatter();
  return (
    <time dateTime={at} className="whitespace-nowrap tabular-nums">
      {format.dateTime(new Date(at), { dateStyle: 'medium', timeStyle: 'medium' })}
    </time>
  );
}

function Person({ id, name }: { id: string | null; name: string | undefined }) {
  const t = useTranslations('setup.viewers');
  if (!id) return <span className="text-fg-secondary">{t('system')}</span>;
  if (name === undefined) return <Skeleton className="h-4 w-24" />;
  return <>{name || t('removedUser')}</>;
}

/** Expandable JSON for payloads and before/after states. */
function JsonDetails({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && Object.keys(value).length === 0) return null;
  return (
    <details className="text-caption">
      <summary className="cursor-pointer text-link">{label}</summary>
      <pre className="mt-1 max-w-xl overflow-x-auto whitespace-pre-wrap rounded-sm bg-subtle p-2 font-mono">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

function ViewerTable<T>({
  headers,
  items,
  row,
  more,
  failure,
}: {
  headers: string[];
  items: T[] | null;
  row: (item: T) => ReactNode;
  more: (() => void) | null;
  failure: ApiResult<unknown> | null;
}) {
  const t = useTranslations('setup.viewers');
  const tc = useTranslations('setup.common');
  const problem = useSetupProblem();
  if (failure && !items) return <Banner tone="danger">{problem(failure)}</Banner>;
  if (!items)
    return (
      <div aria-busy="true" className="flex flex-col gap-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    );
  if (items.length === 0)
    return (
      <EmptyState
        icon={<ListFilter />}
        title={t('empty.title')}
        description={t('empty.description')}
      />
    );
  return (
    <div className="flex flex-col gap-3">
      <table className="w-full border-collapse text-body-sm">
        <thead>
          <tr className="border-b border-line text-caption text-fg-secondary">
            {headers.map((h) => (
              <th key={h} scope="col" className="px-3 py-2 text-start align-bottom font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{items.map(row)}</tbody>
      </table>
      {more ? (
        <Button className="self-center" onClick={more}>
          {tc('loadMore')}
        </Button>
      ) : null}
    </div>
  );
}

const Cell = ({ children, mono }: { children: ReactNode; mono?: boolean }) => (
  <td className={`px-3 py-2 align-top ${mono ? 'font-mono text-caption' : ''}`}>{children}</td>
);

// ── Audit log ──────────────────────────────────────────────────────────────────────────────
function ChainStatus() {
  const t = useTranslations('setup.auditLog.chain');
  const format = useFormatter();
  const { data } = useResource<z.infer<typeof AuditChainStatus>>('/v1/audit-log/verification');
  if (!data) return null;
  const v = data.lastVerification;
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <div className="flex flex-col gap-2">
      {v === null ? (
        <Banner tone="info">{t('never')}</Banner>
      ) : v.status === 'OK' ? (
        <Banner tone="info">
          {t('ok', {
            verifiedAt: when(v.verifiedAt),
            rows: v.rows,
            throughSeq: v.throughSeq ?? '0',
          })}
        </Banner>
      ) : (
        <Banner tone="danger">
          {t('broken', { verifiedAt: when(v.verifiedAt), problem: v.problem ?? '' })}
        </Banner>
      )}
      {data.chainedThroughSeq ? (
        <p className="text-caption text-fg-secondary">
          {t('progress', { seq: data.chainedThroughSeq, unchained: data.unchained })}
        </p>
      ) : null}
    </div>
  );
}

/** Setup → Audit log (§6.7): the hash-chained record audit, newest first, with its chain status. */
export function AuditLogViewer() {
  const t = useTranslations('setup.auditLog');
  const tv = useTranslations('setup.viewers');
  const tAll = useTranslations();
  const [action, setAction] = useState('');
  const [object, setObject] = useState('');
  const [actorId, setActorId] = useState<string | null>(null);
  const [applied, setApplied] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => {
      setApplied(action.trim());
    }, 300);
    return () => {
      clearTimeout(timer);
    };
  }, [action]);
  const list = usePaged('/v1/audit-log', { action: applied, object, actorId }, AuditLogEntry);
  const names = useUserNames(list.items?.map((e) => e.actorId) ?? []);
  const objectLabel = (o: string) =>
    tAll(`objects.${camelCase(o)}.plural` as Parameters<typeof tAll>[0]);
  return (
    <>
      <SetupHeader title={t('title')} description={t('description')} />
      <div className="flex flex-col gap-4 p-[var(--page-padding)]">
        <ChainStatus />
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label={t('actionFilter')}
            placeholder={t('actionPlaceholder')}
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
            }}
            className="w-56"
          />
          <Select
            aria-label={t('objectFilter')}
            value={object || 'ALL'}
            onValueChange={(v) => {
              setObject(v === 'ALL' ? '' : v);
            }}
            options={[
              { value: 'ALL', label: t('allObjects') },
              ...STANDARD_OBJECTS.map((o) => ({ value: o.apiName, label: objectLabel(o.apiName) })),
            ]}
            className="w-48"
          />
          <div className="w-64">
            <UserPicker
              value={actorId}
              onChange={setActorId}
              placeholder={tv('allUsers')}
              emptyLabel={tv('allUsers')}
            />
          </div>
        </div>
        <ViewerTable
          headers={[t('seq'), tv('when'), tv('who'), tv('action'), tv('record'), tv('details')]}
          items={list.items}
          more={list.more}
          failure={list.failure}
          row={(e) => (
            <tr key={e.id} className="border-b border-line-subtle">
              <Cell mono>{e.seq}</Cell>
              <Cell>
                <When at={e.occurredAt} />
              </Cell>
              <Cell>
                {e.actorType === 'user' ? (
                  <Person id={e.actorId} name={names(e.actorId)} />
                ) : (
                  t(`actors.${e.actorType}`)
                )}
              </Cell>
              <Cell mono>{e.action}</Cell>
              <Cell>
                {e.object ? objectLabel(e.object) : null}
                {e.recordId ? (
                  <span className="block font-mono text-caption text-fg-secondary">
                    {e.recordId}
                  </span>
                ) : null}
              </Cell>
              <Cell>
                <div className="flex flex-col gap-1">
                  {e.chained ? null : <StatusChip tone="info">{t('pending')}</StatusChip>}
                  <JsonDetails label={tv('showDetails')} value={e.payload} />
                </div>
              </Cell>
            </tr>
          )}
        />
      </div>
    </>
  );
}

// ── Login history ──────────────────────────────────────────────────────────────────────────
type Outcome = z.infer<typeof LoginHistoryEntry>['outcome'];
type Method = z.infer<typeof LoginHistoryEntry>['method'];
const OUTCOME_TONE: Record<Outcome, 'success' | 'warning' | 'danger' | 'neutral' | 'info'> = {
  SUCCESS: 'success',
  MFA_REQUIRED: 'info',
  INVALID_CREDENTIALS: 'warning',
  INVALID_CODE: 'warning',
  LOCKED: 'danger',
  EMAIL_NOT_VERIFIED: 'neutral',
  NO_ACCOUNT: 'warning',
};
const OUTCOME_KEY = {
  SUCCESS: 'success',
  MFA_REQUIRED: 'mfaRequired',
  INVALID_CREDENTIALS: 'invalidCredentials',
  INVALID_CODE: 'invalidCode',
  LOCKED: 'locked',
  EMAIL_NOT_VERIFIED: 'emailNotVerified',
  NO_ACCOUNT: 'noAccount',
} as const;
const METHOD_KEY: Record<Method, 'password' | 'google' | 'microsoft' | 'otp' | 'recoveryCode'> = {
  password: 'password',
  google: 'google',
  microsoft: 'microsoft',
  otp: 'otp',
  recovery_code: 'recoveryCode',
};

/** Setup → Login history (§6.7): every sign-in attempt, filterable by user and outcome. */
export function LoginHistoryViewer() {
  const t = useTranslations('setup.loginHistory');
  const tv = useTranslations('setup.viewers');
  const [userId, setUserId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState('');
  const list = usePaged('/v1/login-history', { userId, outcome }, LoginHistoryEntry);
  const names = useUserNames(list.items?.map((e) => e.userId) ?? []);
  return (
    <>
      <SetupHeader title={t('title')} description={t('description')} />
      <div className="flex flex-col gap-4 p-[var(--page-padding)]">
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-64">
            <UserPicker
              value={userId}
              onChange={setUserId}
              placeholder={tv('allUsers')}
              emptyLabel={tv('allUsers')}
            />
          </div>
          <Select
            aria-label={t('outcome')}
            value={outcome || 'ALL'}
            onValueChange={(v) => {
              setOutcome(v === 'ALL' ? '' : v);
            }}
            options={[
              { value: 'ALL', label: t('allOutcomes') },
              ...(Object.keys(OUTCOME_KEY) as Outcome[]).map((o) => ({
                value: o,
                label: t(`outcomes.${OUTCOME_KEY[o]}`),
              })),
            ]}
            className="w-56"
          />
        </div>
        <ViewerTable
          headers={[tv('when'), tv('user'), t('method'), t('outcome'), t('ip'), t('device')]}
          items={list.items}
          more={list.more}
          failure={list.failure}
          row={(e) => (
            <tr key={e.id} className="border-b border-line-subtle">
              <Cell>
                <When at={e.occurredAt} />
              </Cell>
              <Cell>
                {e.userId ? (
                  <Person id={e.userId} name={names(e.userId)} />
                ) : (
                  <span className="text-fg-secondary">{tv('unknownUser')}</span>
                )}
              </Cell>
              <Cell>{t(`methods.${METHOD_KEY[e.method]}`)}</Cell>
              <Cell>
                <StatusChip tone={OUTCOME_TONE[e.outcome]} dot>
                  {t(`outcomes.${OUTCOME_KEY[e.outcome]}`)}
                </StatusChip>
              </Cell>
              <Cell mono>{e.ip}</Cell>
              <Cell>
                <span className="line-clamp-2 max-w-72 text-caption text-fg-secondary">
                  {e.userAgent}
                </span>
              </Cell>
            </tr>
          )}
        />
      </div>
    </>
  );
}

// ── Setup audit trail ──────────────────────────────────────────────────────────────────────
const ENTITY_TYPES = [
  'user',
  'org_unit',
  'profile',
  'permission_set',
  'permission_set_group',
  'public_group',
  'queue',
  'org_wide_default',
  'sharing_rule',
] as const;
type EntityType = (typeof ENTITY_TYPES)[number];
const typeKey = (type: string) =>
  camelCase(type) as
    | 'user'
    | 'orgUnit'
    | 'profile'
    | 'permissionSet'
    | 'permissionSetGroup'
    | 'publicGroup'
    | 'queue'
    | 'orgWideDefault'
    | 'sharingRule';

/** Setup → Setup audit trail (§5.6): configuration changes with their before and after state. */
export function SetupAuditViewer() {
  const t = useTranslations('setup.setupAudit');
  const tv = useTranslations('setup.viewers');
  const tAll = useTranslations();
  const [entityType, setEntityType] = useState<EntityType | ''>('');
  const list = usePaged('/v1/setup-audit', { entityType }, SetupAuditEntry);
  const names = useUserNames(list.items?.map((e) => e.actorId) ?? []);
  const known = (type: string): type is EntityType =>
    (ENTITY_TYPES as readonly string[]).includes(type);
  return (
    <>
      <SetupHeader title={t('title')} description={t('description')} />
      <div className="flex flex-col gap-4 p-[var(--page-padding)]">
        <Select
          aria-label={t('entityFilter')}
          value={entityType || 'ALL'}
          onValueChange={(v) => {
            setEntityType(v === 'ALL' ? '' : (v as EntityType));
          }}
          options={[
            { value: 'ALL', label: t('allTypes') },
            ...ENTITY_TYPES.map((type) => ({ value: type, label: t(`types.${typeKey(type)}`) })),
          ]}
          className="w-60"
        />
        <ViewerTable
          headers={[tv('when'), tv('who'), tv('action'), t('entity'), tv('details')]}
          items={list.items}
          more={list.more}
          failure={list.failure}
          row={(e) => (
            <tr key={e.id} className="border-b border-line-subtle">
              <Cell>
                <When at={e.occurredAt} />
              </Cell>
              <Cell>
                <Person id={e.actorId} name={names(e.actorId)} />
              </Cell>
              <Cell mono>{e.action}</Cell>
              <Cell>
                <span className="block text-caption text-fg-secondary">
                  {known(e.entityType) ? t(`types.${typeKey(e.entityType)}`) : e.entityType}
                </span>
                {e.entityType === 'org_wide_default' && e.entityName
                  ? tAll(`objects.${camelCase(e.entityName)}.plural` as Parameters<typeof tAll>[0])
                  : e.entityName}
              </Cell>
              <Cell>
                <div className="flex flex-col gap-1">
                  <JsonDetails label={t('before')} value={e.before} />
                  <JsonDetails label={t('after')} value={e.after} />
                </div>
              </Cell>
            </tr>
          )}
        />
      </div>
    </>
  );
}
