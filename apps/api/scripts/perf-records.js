// §11.1 API budgets on the records engine (P02 T28). Run against a running API whose cell is seeded
// with `pnpm db:seed --scenario=bank --scale=load` (500k leads):
//
//   node --env-file=../../.env scripts/perf-records.js [--runs=100] [--report-only]
//
// It signs in as a telesales agent, a branch manager (sees the agents under them) and the
// administrator, then times sequential requests from the client: record read, update and create,
// list view first page (50 rows, sharing on: all, an indexed filter, a sort, "mine"), global search
// and lead conversion. It prints p50/p95 per operation and exits 1 when a p95 breaks its budget.
// Development and CI cells only: it reads the tenant and its users through CELL_ADMIN_DATABASE_URL,
// and it writes (updates titles, creates leads named "Perf …", converts a few leads).
import pg from 'pg';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const RUNS = Number(arg('runs', '100'));
const SLUG = arg('tenant', 'aurelia-demo');
const API = arg('api', process.env['API_URL'] ?? 'http://localhost:4000');
const REPORT_ONLY = process.argv.includes('--report-only');
const PASSWORD = process.env['SEED_PASSWORD'] ?? 'demo passphrase 4821';
const env = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
};

/** p95 budgets in ms (§11.1); conversion has none in the spec and is reported only. */
const BUDGET = { read: 120, write: 250, list: 400, search: 200 };

const admin = new pg.Client({ connectionString: env('CELL_ADMIN_DATABASE_URL') });
await admin.connect();
const one = async (sql, params) => (await admin.query(sql, params)).rows[0];
const tenant = await one('SELECT tenant_id FROM tenant_settings WHERE slug = $1', [SLUG]);
if (!tenant) throw new Error(`No tenant ${SLUG} in this cell: seed it first`);
const tenantId = tenant.tenant_id;
// The busiest agent, their manager's level, and the administrator.
const byProfile = (profile, extra = '') =>
  one(
    `SELECT u.email FROM "user" u JOIN profile p ON p.tenant_id = u.tenant_id AND p.id = u.profile_id
     WHERE u.tenant_id = $1 AND p.name = $2 AND u.status = 'ACTIVE' ${extra}
     ORDER BY (SELECT count(*) FROM lead l WHERE l.tenant_id = u.tenant_id AND l.owner_id = u.id) DESC
     LIMIT 1`,
    [tenantId, profile],
  );
const users = {
  agent: (await byProfile('Telesales Agent'))?.email,
  manager: (await byProfile('Branch Manager'))?.email,
  admin: (await byProfile('System Administrator'))?.email,
};
const leads = await one('SELECT count(*)::int AS n FROM lead WHERE tenant_id = $1', [tenantId]);
await admin.end();

async function signIn(email) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sm-tenant-id': tenantId },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Sign-in failed for ${email}: ${String(res.status)}`);
  return (await res.json()).tokens.accessToken;
}
const tokens = {};
for (const [who, email] of Object.entries(users)) {
  if (!email) throw new Error(`No ${who} in ${SLUG}`);
  tokens[who] = await signIn(email);
}

// The API limits each IP to 20 requests a second; stay under it (the wait is not timed).
const SPACING_MS = 55;
let lastStart = 0;
async function call(who, method, path, body) {
  const wait = lastStart + SPACING_MS - performance.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastStart = performance.now();
  const started = performance.now();
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${tokens[who]}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const ms = performance.now() - started;
  if (res.status >= 400) throw new Error(`${method} ${path}: ${String(res.status)} ${text}`);
  return { ms, json: text ? JSON.parse(text) : null };
}

const results = [];
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
async function measure(name, kind, fn, runs = RUNS) {
  for (let i = 0; i < 5; i++) await fn(i); // warm the caches a real session has warm
  const times = [];
  for (let i = 0; i < runs; i++) times.push((await fn(i + 5)).ms);
  times.sort((a, b) => a - b);
  const row = {
    name,
    kind,
    runs,
    p50: Number(quantile(times, 0.5).toFixed(1)),
    p95: Number(quantile(times, 0.95).toFixed(1)),
    budget: BUDGET[kind] ?? null,
  };
  row.ok = row.budget === null || row.p95 <= row.budget;
  results.push(row);
  process.stdout.write(
    `${name.padEnd(40)} p50 ${String(row.p50).padStart(6)} ms  p95 ${String(row.p95).padStart(6)} ms` +
      `${row.budget === null ? '' : `  (budget ${String(row.budget)})${row.ok ? '' : '  OVER'}`}\n`,
  );
}

const views = {};
for (const who of Object.keys(users)) {
  const { json } = await call(who, 'GET', '/v1/objects/lead/list-views');
  views[who] = Object.fromEntries(json.items.map((v) => [v.systemKey ?? v.id, v.id]));
}
const run = (who, view, body) =>
  call(who, 'POST', `/v1/objects/lead/list-views/${views[who][view]}/results`, body);
// Leads still open: earlier runs convert some (converted leads are read-only).
const sample = (
  await run('agent', 'mine', { limit: 200, where: { field: 'converted_at', op: 'is_null' } })
).json.items;
const ids = sample.map((r) => r.id);
if (ids.length < 40) throw new Error('The agent owns too few open leads to measure');
process.stdout.write(
  `${SLUG}: ${String(leads.n)} leads; agent ${users.agent}, manager ${users.manager}\n\n`,
);

await measure('read lead (agent)', 'read', (i) =>
  call('agent', 'GET', `/v1/records/lead/${ids[i % ids.length]}`),
);
await measure('read lead (admin)', 'read', (i) =>
  call('admin', 'GET', `/v1/records/lead/${ids[i % ids.length]}`),
);
await measure('update lead (agent)', 'write', (i) =>
  call('agent', 'PATCH', `/v1/records/lead/${ids[i % ids.length]}`, {
    fields: { title: `Perf ${String(i)}` },
  }),
);
await measure('create lead (agent)', 'write', (i) =>
  call('agent', 'POST', '/v1/records/lead', {
    fields: { last_name: `Perf ${String(i)}`, company: `Perf Trading ${String(i)}` },
  }),
);
for (const who of ['agent', 'manager', 'admin']) {
  await measure(`list all, first page (${who})`, 'list', () => run(who, 'all', { count: true }));
  await measure(`list all, status = working (${who})`, 'list', () =>
    run(who, 'all', { where: { field: 'status', op: 'eq', value: 'working' }, count: true }),
  );
  await measure(`list all, by last name (${who})`, 'list', () =>
    run(who, 'all', { sort: [{ field: 'last_name', direction: 'asc' }] }),
  );
  await measure(`list mine (${who})`, 'list', () => run(who, 'mine', { count: true }));
}
const names = [...new Set(sample.map((r) => r.last_name).filter(Boolean))];
const companies = [...new Set(sample.map((r) => r.company).filter(Boolean))];
for (const who of ['agent', 'admin']) {
  await measure(`search a last name (${who})`, 'search', (i) =>
    call(who, 'GET', `/v1/search?q=${encodeURIComponent(names[i % names.length])}`),
  );
  await measure(`search a company prefix (${who})`, 'search', (i) =>
    call(
      who,
      'GET',
      `/v1/search?q=${encodeURIComponent(companies[i % companies.length].slice(0, 5))}`,
    ),
  );
}
const toConvert = ids.slice(-20);
await measure(
  'convert lead (agent)',
  'convert',
  (i) =>
    call('agent', 'POST', `/v1/leads/${toConvert[i]}/convert`, {
      account: { fields: {} },
      contact: { fields: {} },
      opportunity: {
        fields: { close_date: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10) },
      },
    }),
  toConvert.length - 5,
);

const over = results.filter((r) => !r.ok);
process.stdout.write(`\n${JSON.stringify({ tenant: SLUG, leads: leads.n, results })}\n`);
if (over.length && !REPORT_ONLY) {
  process.stderr.write(`Over budget: ${over.map((r) => r.name).join(', ')}\n`);
  process.exit(1);
}
