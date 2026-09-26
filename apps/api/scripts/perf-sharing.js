// Bank-scale sharing check (P01 T22). Run against a cell seeded with `pnpm db:seed --scenario=bank`:
//
//   node --env-file=../../.env scripts/perf-sharing.js [--rows=500000] [--keep]
//
// It adds a fixture record table (`perf_account`, shaped like every CRM table: tenant_id, id,
// owner_id; forced RLS) to the bank tenant, then measures the owner-visibility closure (size, full
// and subtree rebuild), the principal set (computed and cached), and the sharing predicate on a
// list page of 50 rows for users at every level of the hierarchy. The table is dropped afterwards
// unless --keep is given. Development cells only: it needs CELL_ADMIN_DATABASE_URL.
import { createCellPrisma, disposeCellPrisma, principalsOf, visibility, withTenant } from '@sm/db';
import { VersionedCache } from '@sm/permissions';
import { sharingPredicate } from '@sm/query-engine';
import { Redis } from 'ioredis';
import pg from 'pg';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const ROWS = Number(arg('rows', '500000'));
const KEEP = process.argv.includes('--keep');
const SLUG = arg('tenant', 'aurelia-demo');
const RUNS = Number(arg('runs', '40'));
const env = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

const admin = new pg.Client({ connectionString: env('CELL_ADMIN_DATABASE_URL') });
await admin.connect();
const prisma = createCellPrisma(env('CELL_DATABASE_URL'));
const redis = new Redis(env('REDIS_URL'), { lazyConnect: true, maxRetriesPerRequest: 1 });
await redis.connect();

const out = [];
const log = (line) => {
  out.push(line);
  process.stdout.write(`${line}\n`);
};
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0;
};
const ms = (n) => `${n.toFixed(1)} ms`;
async function timed(fn) {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - t0 };
}

try {
  const tenant = await admin.query('SELECT tenant_id FROM tenant_settings WHERE slug = $1', [SLUG]);
  const tenantId = tenant.rows[0]?.tenant_id;
  if (!tenantId) throw new Error(`no tenant ${SLUG}; run pnpm db:seed --scenario=bank first`);
  const inTenant = (fn, timeoutMs = 120_000) => withTenant(prisma, { tenantId }, fn, { timeoutMs });

  // Users by depth in the org tree (0 = top), so each level of the hierarchy gets measured.
  const users = (
    await admin.query(
      `SELECT u.id, u.title, u.org_unit_id,
              (SELECT count(*) - 1 FROM org_unit_closure c
                WHERE c.tenant_id = u.tenant_id AND c.descendant_id = u.org_unit_id)::int AS depth
         FROM "user" u WHERE u.tenant_id = $1 AND u.status = 'ACTIVE' ORDER BY u.id`,
      [tenantId],
    )
  ).rows;
  const units = await admin.query(
    'SELECT count(*)::int AS n, max(depth)::int AS depth FROM org_unit_closure WHERE tenant_id = $1',
    [tenantId],
  );
  log(
    `tenant ${SLUG}: ${String(users.length)} active users, org depth ${String(units.rows[0].depth)}`,
  );

  // ── Fixture table ──────────────────────────────────────────────────────────────────────────
  await admin.query('DROP TABLE IF EXISTS perf_account');
  await admin.query('SET ROLE sm_migrator');
  await admin.query(`
    CREATE TABLE perf_account (tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT uuid_generate_v7(),
      owner_id uuid NOT NULL, name text NOT NULL, PRIMARY KEY (tenant_id, id));
    CREATE INDEX perf_account_owner ON perf_account (tenant_id, owner_id, name);
    CREATE INDEX perf_account_name ON perf_account (tenant_id, name, id);
    SELECT enable_tenant_rls('perf_account');`);
  await admin.query('RESET ROLE');
  const load = await timed(() =>
    admin.query(
      `INSERT INTO perf_account (tenant_id, owner_id, name)
       SELECT $1, owners[1 + (hashint4(g) & 2147483647) % array_length(owners, 1)],
              'Account ' || lpad(((hashint4(g * 7) & 2147483647) % 1000000)::text, 6, '0')
         FROM generate_series(1, $2) g,
              (SELECT array_agg(id ORDER BY id) AS owners FROM "user"
                WHERE tenant_id = $1 AND status = 'ACTIVE') o`,
      [tenantId, ROWS],
    ),
  );
  // 5% of the records carry an explicit share: to a public group, to an org unit and its
  // subordinates, or to a single user (the three shapes the predicate matches).
  const groups = (
    await admin.query('SELECT id FROM public_group WHERE tenant_id = $1 ORDER BY id', [tenantId])
  ).rows.map((r) => r.id);
  const orgUnits = (
    await admin.query('SELECT id FROM org_unit WHERE tenant_id = $1 ORDER BY id', [tenantId])
  ).rows.map((r) => r.id);
  await admin.query(
    `INSERT INTO record_share (tenant_id, object, record_id, principal_type, principal_id, access, reason)
     SELECT a.tenant_id, 'perf_account', a.id,
            (CASE k WHEN 0 THEN 'GROUP' WHEN 1 THEN 'ORG_UNIT_AND_SUBORDINATES' ELSE 'USER' END)::share_principal_type,
            (CASE k WHEN 0 THEN $2::uuid[] WHEN 1 THEN $3::uuid[] ELSE $4::uuid[] END)
              [1 + (hashint4(n::int) & 2147483647) % (CASE k WHEN 0 THEN $5::int WHEN 1 THEN $6::int ELSE $7::int END)],
            1, 'MANUAL'::share_reason
       FROM (SELECT tenant_id, id, row_number() OVER (ORDER BY id) AS n,
                    (row_number() OVER (ORDER BY id) % 3)::int AS k
               FROM perf_account WHERE tenant_id = $1) a
      WHERE a.n % 20 = 0`,
    [
      tenantId,
      groups.length ? groups : orgUnits,
      orgUnits,
      users.map((u) => u.id),
      groups.length || orgUnits.length,
      orgUnits.length,
      users.length,
    ],
  );
  await admin.query('ANALYZE perf_account; ANALYZE record_share; ANALYZE user_visibility_closure');
  log(`fixture: ${String(ROWS)} records loaded in ${ms(load.ms)}, ${String(ROWS / 20)} shares`);

  // ── Closure ────────────────────────────────────────────────────────────────────────────────
  const closureRows = async () =>
    (
      await admin.query(
        'SELECT count(*)::int AS n FROM user_visibility_closure WHERE tenant_id = $1',
        [tenantId],
      )
    ).rows[0].n;
  const full = [];
  for (let i = 0; i < 3; i++)
    full.push((await timed(() => inTenant((tx) => visibility.rebuild(tx)))).ms);
  log(
    `closure: ${String(await closureRows())} rows; full rebuild p50 ${ms(pct(full, 50))} (3 runs)`,
  );
  // A change to a leaf unit (a rep joins or leaves a team): everyone above it is recomputed. A
  // change at the root recomputes everyone, which is the full rebuild above.
  const deepest = Math.max(...users.map((u) => u.depth));
  const mid = users.find((u) => u.depth === deepest && u.org_unit_id) ?? users[0];
  const subtree = [];
  let affected = 0;
  for (let i = 0; i < 5; i++) {
    subtree.push(
      (
        await timed(() =>
          inTenant(async (tx) => {
            const viewers = await visibility.viewersAbove(tx, [mid.org_unit_id]);
            affected = viewers.length;
            return visibility.rebuild(tx, viewers);
          }),
        )
      ).ms,
    );
  }
  log(
    `closure: leaf-unit rebuild (${String(affected)} viewers above it) p50 ${ms(pct(subtree, 50))}, max ${ms(Math.max(...subtree))}`,
  );

  // ── Principal set ──────────────────────────────────────────────────────────────────────────
  const cache = new VersionedCache(redis, 'perf-principals');
  const sample = users.filter((_, i) => i % Math.max(1, Math.floor(users.length / 50)) === 0);
  const computed = [];
  const hits = [];
  for (const u of sample) {
    computed.push((await timed(() => inTenant((tx) => principalsOf(tx, u.id)))).ms);
    await inTenant((tx) => cache.getOrCompute(tenantId, u.id, 1, () => principalsOf(tx, u.id)));
    hits.push(
      (
        await timed(() =>
          cache.getOrCompute(tenantId, u.id, 1, () => {
            throw new Error('expected a cache hit');
          }),
        )
      ).ms,
    );
  }
  log(
    `principals (${String(sample.length)} users): computed p50 ${ms(pct(computed, 50))} p95 ${ms(pct(computed, 95))}; cache hit p50 ${ms(pct(hits, 50))} p95 ${ms(pct(hits, 95))}`,
  );

  // ── Sharing predicate on a 50-row list page ────────────────────────────────────────────────
  const objectSharing = () => ({
    object: 'perf_account',
    table: 'perf_account',
    sharingModel: 'PRIVATE',
    grantHierarchy: true,
  });
  // One user per level of reach: the head of sales sees everyone's records, a rep only their own.
  const reach = (
    await admin.query(
      `SELECT v.viewer_user_id AS id, count(*)::int AS n FROM user_visibility_closure v
        WHERE v.tenant_id = $1 GROUP BY 1`,
      [tenantId],
    )
  ).rows;
  const reachOf = new Map(reach.map((r) => [r.id, r.n]));
  const byReach = new Map();
  for (const u of users) {
    const n = reachOf.get(u.id) ?? 0;
    if (u.org_unit_id && !byReach.has(n)) byReach.set(n, u);
  }
  const cases = [...byReach.entries()].sort((a, b) => b[0] - a[0]);
  const page = (tx, ctx, order) =>
    tx.kysely
      .selectFrom('perf_account as r')
      .select(['r.id', 'r.name', 'r.owner_id'])
      .where(() => sharingPredicate(ctx, 'perf_account', 'r', 'read'))
      .orderBy(order === 'name' ? 'r.name' : 'r.id', order === 'name' ? 'asc' : 'desc')
      .orderBy('r.id')
      .limit(50);
  let worst = 0;
  for (const [owners, u] of cases) {
    const principals = await inTenant((tx) => principalsOf(tx, u.id));
    const ctx = { tenantId, principals, objectSharing, bypasses: () => false };
    const visible = await inTenant(async (tx) => {
      const r = await tx.kysely
        .selectFrom('perf_account as r')
        .select((eb) => eb.fn.countAll().as('n'))
        .where(() => sharingPredicate(ctx, 'perf_account', 'r', 'read'))
        .executeTakeFirst();
      return Number(r?.n ?? 0);
    });
    for (const order of ['name', 'recent']) {
      const runs = [];
      let rows = 0;
      for (let i = 0; i < RUNS; i++) {
        const t = await timed(() => inTenant((tx) => page(tx, ctx, order).execute()));
        rows = t.value.length;
        if (i >= 3) runs.push(t.ms); // the first runs warm the cache
      }
      worst = Math.max(worst, pct(runs, 95));
      log(
        `list ${u.title} (hierarchy reaches ${String(owners)} owners; ${String(visible)} visible, ${String(rows)} returned, by ${order}): p50 ${ms(pct(runs, 50))} p95 ${ms(pct(runs, 95))}`,
      );
    }
  }
  log(`worst list p95 ${ms(worst)} — budget 400 ms (§11.1): ${worst <= 400 ? 'PASS' : 'FAIL'}`);
  process.exitCode = worst <= 400 ? 0 : 1;
} finally {
  if (!KEEP) {
    await admin.query("DELETE FROM record_share WHERE object = 'perf_account'");
    await admin.query('DROP TABLE IF EXISTS perf_account');
  }
  await redis.quit();
  await disposeCellPrisma(prisma);
  await admin.end();
}
