import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request context carried through async calls (§3.6, §11.4). The request id is always set;
 * tenant and user are filled in by the auth/tenant guards once the caller is verified.
 */
export interface RequestContext {
  requestId: string;
  tenantId?: string;
  userId?: string;
  route?: string;
  /** Database statements issued while serving this request (OTel `db.statement.count`). */
  dbStatements: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const requestContext = {
  /** Enter a new context for the rest of the current async execution (used in onRequest hooks). */
  enter(requestId: string): RequestContext {
    const ctx: RequestContext = { requestId, dbStatements: 0 };
    storage.enterWith(ctx);
    return ctx;
  },
  run<T>(ctx: RequestContext, fn: () => T): T {
    return storage.run(ctx, fn);
  },
  get(): RequestContext | undefined {
    return storage.getStore();
  },
  /** Record the verified tenant and user for logs and spans. */
  identify(tenantId: string, userId?: string): void {
    const ctx = storage.getStore();
    if (!ctx) return;
    ctx.tenantId = tenantId;
    if (userId) ctx.userId = userId;
  },
  countDbStatement(): void {
    const ctx = storage.getStore();
    if (ctx) ctx.dbStatements += 1;
  },
};

const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Accept an inbound `x-request-id` only if it is a sane token; otherwise the caller gets a new one. */
export function acceptRequestId(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  return value && REQUEST_ID.test(value) ? value : undefined;
}
