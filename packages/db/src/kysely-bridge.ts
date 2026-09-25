import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
} from 'kysely';

/**
 * The minimal surface of a Prisma interactive-transaction client that Kysely needs. Every
 * statement Kysely builds runs through these methods, so it executes on the **same connection
 * and transaction** as the Prisma calls around it, and sees the transaction-local
 * `app.tenant_id` (ADR-0004, §3.5).
 */
export interface RawSqlExecutor {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/** Row type for dynamic, metadata-driven SQL (Query Engine, RecordService). */
export type DynamicDatabase = Record<string, Record<string, unknown>>;

function returnsRows(query: CompiledQuery): boolean {
  const node = query.query as { kind: string; returning?: unknown };
  return node.kind === 'SelectQueryNode' || node.kind === 'RawNode' || node.returning !== undefined;
}

class PrismaTransactionConnection implements DatabaseConnection {
  constructor(private readonly tx: RawSqlExecutor) {}

  async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
    const params = [...compiled.parameters];
    if (returnsRows(compiled)) {
      const rows = await this.tx.$queryRawUnsafe<R[]>(compiled.sql, ...params);
      return { rows };
    }
    const affected = await this.tx.$executeRawUnsafe(compiled.sql, ...params);
    return { rows: [], numAffectedRows: BigInt(affected) };
  }

  streamQuery(): AsyncIterableIterator<QueryResult<never>> {
    throw new Error('Streaming is not supported inside a tenant transaction');
  }
}

class PrismaTransactionDriver implements Driver {
  private readonly connection: PrismaTransactionConnection;

  constructor(tx: RawSqlExecutor) {
    this.connection = new PrismaTransactionConnection(tx);
  }

  async init(): Promise<void> {}

  acquireConnection(): Promise<DatabaseConnection> {
    return Promise.resolve(this.connection);
  }

  // The enclosing withTenant() owns the transaction; Kysely must not open or end one.
  beginTransaction(): Promise<void> {
    return Promise.reject(new Error('Already inside the tenant transaction; use withTenant()'));
  }

  commitTransaction(): Promise<void> {
    return Promise.reject(new Error('The tenant transaction is committed by withTenant()'));
  }

  rollbackTransaction(): Promise<void> {
    return Promise.reject(new Error('The tenant transaction is rolled back by withTenant()'));
  }

  async releaseConnection(): Promise<void> {}

  async destroy(): Promise<void> {}
}

/** Kysely dialect that executes on an open Prisma interactive transaction. */
export class PrismaTransactionDialect implements Dialect {
  constructor(private readonly tx: RawSqlExecutor) {}

  createAdapter() {
    return new PostgresAdapter();
  }

  createDriver(): Driver {
    return new PrismaTransactionDriver(this.tx);
  }

  createIntrospector(db: Kysely<DynamicDatabase>) {
    return new PostgresIntrospector(db);
  }

  createQueryCompiler() {
    return new PostgresQueryCompiler();
  }
}

export function kyselyForTransaction(tx: RawSqlExecutor): Kysely<DynamicDatabase> {
  return new Kysely<DynamicDatabase>({ dialect: new PrismaTransactionDialect(tx) });
}
