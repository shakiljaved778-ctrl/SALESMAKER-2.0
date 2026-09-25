/**
 * Spike made permanent (ADR-0004, §3.5): the tenant transaction must be safe behind PgBouncer
 * in **transaction** pooling mode, where consecutive transactions from different clients share
 * server connections. set_config(..., true) is transaction-local, so nothing may leak.
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCellPrisma, type CellPrisma } from '../src/client.js';
import { withTenant } from '../src/tenant.js';
import {
  createTestCellDatabase,
  ensureTestCellRoles,
  PASSWORDS,
} from '../src/testing/cell-database.js';

const TENANT_A = '01920000-0000-7000-8000-0000000000a1';
const TENANT_B = '01920000-0000-7000-8000-0000000000b2';

let network: StartedNetwork;
let postgres: StartedPostgreSqlContainer;
let bouncer: StartedTestContainer;
let clients: CellPrisma[] = [];

beforeAll(async () => {
  network = await new Network().start();
  postgres = await new PostgreSqlContainer('pgvector/pgvector:pg16')
    .withNetwork(network)
    .withNetworkAliases('pg')
    .start();
  const serverUrl = postgres.getConnectionUri();
  await ensureTestCellRoles(serverUrl);
  const cell = await createTestCellDatabase(serverUrl);

  bouncer = await new GenericContainer('edoburu/pgbouncer:latest')
    .withNetwork(network)
    .withEnvironment({
      DB_HOST: 'pg',
      DB_PORT: '5432',
      DB_NAME: cell.name,
      DB_USER: 'sm_app',
      DB_PASSWORD: PASSWORDS.appPassword,
      AUTH_TYPE: 'scram-sha-256',
      POOL_MODE: 'transaction',
      DEFAULT_POOL_SIZE: '2',
      MAX_CLIENT_CONN: '200',
      MAX_PREPARED_STATEMENTS: '200',
      LISTEN_PORT: '6432',
    })
    .withExposedPorts(6432)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();

  const url = `postgresql://sm_app:${PASSWORDS.appPassword}@${bouncer.getHost()}:${String(bouncer.getMappedPort(6432))}/${cell.name}`;
  // Several independent application instances, all funnelled into two server connections.
  clients = [createCellPrisma(url), createCellPrisma(url), createCellPrisma(url)];
  const [first] = clients;
  if (!first) throw new Error('no client');
  for (const [tenantId, slug] of [
    [TENANT_A, 'alpha'],
    [TENANT_B, 'bravo'],
  ] as const) {
    await withTenant(first, { tenantId }, async ({ prisma }) => {
      await prisma.tenantSettings.create({
        data: {
          tenantId,
          name: slug,
          slug,
          region: 'eu-central-1',
          corporateCurrency: 'USD',
          defaultTimezone: 'UTC',
        },
      });
      await prisma.user.create({ data: { tenantId, email: `owner@${slug}.test`, name: slug } });
    });
  }
}, 180_000);

afterAll(async () => {
  await Promise.all(clients.map((c) => c.$disconnect()));
  await bouncer.stop();
  await postgres.stop();
  await network.stop();
});

describe('withTenant behind PgBouncer transaction pooling', () => {
  it('keeps tenants isolated across many clients sharing two server connections', async () => {
    const checks = await Promise.all(
      Array.from({ length: 60 }, (_, i) => {
        const client = clients[i % clients.length];
        if (!client) throw new Error('no client');
        const tenantId = i % 2 === 0 ? TENANT_A : TENANT_B;
        return withTenant(client, { tenantId }, async ({ prisma, kysely }) => {
          const viaPrisma = await prisma.user.findMany({ select: { tenantId: true } });
          const viaKysely = await kysely.selectFrom('user').select('tenant_id').execute();
          return (
            viaPrisma.length === 1 &&
            viaPrisma[0]?.tenantId === tenantId &&
            viaKysely.length === 1 &&
            viaKysely[0]?.['tenant_id'] === tenantId
          );
        });
      }),
    );
    expect(checks.filter((ok) => !ok)).toEqual([]);
  });

  it('never leaks a tenant setting to the next client on a reused server connection', async () => {
    const leaks = await Promise.all(
      Array.from({ length: 30 }, async (_, i) => {
        const client = clients[i % clients.length];
        if (!client) throw new Error('no client');
        await withTenant(client, { tenantId: TENANT_A }, ({ prisma }) => prisma.user.count());
        const [row] = await client.$queryRaw<{ tenant: string | null; users: bigint }[]>`
          SELECT current_setting('app.tenant_id', true) AS tenant, (SELECT count(*) FROM "user") AS users`;
        return (row?.tenant ?? '') !== '' || row?.users !== 0n;
      }),
    );
    expect(leaks.filter(Boolean)).toEqual([]);
  });
});
