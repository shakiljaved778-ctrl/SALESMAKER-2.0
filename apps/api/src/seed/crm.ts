import { withTenant, type CellPrisma, type TenantTransaction } from '@sm/db';
import { bulkCreate, loadRecordContext, type RecordContext, type WriteInput } from '@sm/records';
import { sql } from 'kysely';

import { syncStandardMetadata } from '../metadata/standard-metadata.js';
import type { ScenarioName, SeedPlan } from './scenarios.js';

/**
 * CRM demo data (§15, P02 T27): leads, accounts, contacts and opportunities for the seeded
 * workspaces, written through RecordService's bulk path (validation, sharing, history, search
 * vectors, outbox) as the workspace owner. Deterministic: record `i` of an object is a pure
 * function of the scenario and `i`, so a re-run (or a resumed run) produces the same data.
 */
export interface CrmVolumes {
  accounts: number;
  contacts: number;
  leads: number;
  opportunities: number;
}

export const CRM_VOLUMES: Record<ScenarioName, Record<'demo' | 'load', CrmVolumes>> = {
  agency: {
    demo: { accounts: 400, contacts: 900, leads: 2_000, opportunities: 150 },
    load: { accounts: 400, contacts: 900, leads: 2_000, opportunities: 150 },
  },
  bank: {
    // The demo scale keeps the bank quick to seed locally; --scale=load is the §11.1 test bed.
    demo: { accounts: 600, contacts: 900, leads: 5_000, opportunities: 400 },
    load: { accounts: 60_000, contacts: 90_000, leads: 500_000, opportunities: 40_000 },
  },
};

/**
 * Concurrent batches that touch the same parents (contacts of one account recompute its implicit
 * shares) can deadlock; Postgres aborts one transaction, which rolled back whole, so it is retried.
 */
async function retryOnConflict<T>(run: () => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      const conflict = /40P01|40001|deadlock detected|could not serialize/.test(String(err));
      if (!conflict || attempt >= attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

/** Rows per transaction: RecordService's bulk limit. */
const BATCH = 200;
/** A seed with more failing rows than this is broken: stop and say why. */
const MAX_FAILURE_RATE = 0.01;
const DAY = 86_400_000;

// ── Deterministic generation ────────────────────────────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A generator for record `i` of `kind` in a scenario. */
function rngFor(scenario: ScenarioName, kind: string, i: number): () => number {
  let h = 2_166_136_261;
  for (const c of `${scenario}:${kind}`) h = Math.imul(h ^ c.charCodeAt(0), 16_777_619);
  return mulberry32((h ^ Math.imul(i + 1, 2_654_435_761)) >>> 0);
}

const pick = <T>(r: () => number, list: readonly T[]): T =>
  list[Math.floor(r() * list.length)] as T;

const FIRST = [
  'Amira',
  'Omar',
  'Priya',
  'Lina',
  'Jonas',
  'Diego',
  'Sara',
  'Yusuf',
  'Hana',
  'Tom',
  'Noor',
  'Khalid',
  'Maya',
  'Elena',
  'Rami',
  'Fatima',
  'Ivan',
  'Leila',
  'Marco',
  'Aisha',
] as const;
const LAST = [
  'Chen',
  'Haddad',
  'Nair',
  'Park',
  'Weber',
  'Santos',
  'Okafor',
  'Aziz',
  'Sato',
  'Reed',
  'Mansour',
  'Rahman',
  'Kovacs',
  'Ali',
  'Silva',
  'Novak',
  'Hassan',
  'Dubois',
  'Rossi',
  'Khan',
] as const;
const PREFIX = [
  'North',
  'Gulf',
  'Blue',
  'Summit',
  'Harbor',
  'Cedar',
  'Pearl',
  'Atlas',
  'Falcon',
  'Oasis',
  'Crescent',
  'Lusail',
  'Corniche',
  'Desert',
  'Silver',
  'Golden',
] as const;
const CORE = [
  'Logistics',
  'Trading',
  'Holdings',
  'Retail',
  'Ventures',
  'Foods',
  'Telecom',
  'Hospitality',
  'Healthcare',
  'Energy',
  'Systems',
  'Studios',
  'Partners',
  'Capital',
] as const;
const CITIES = [
  'Doha',
  'Dubai',
  'Riyadh',
  'Muscat',
  'Manama',
  'Kuwait City',
  'London',
  'Lisbon',
  'Berlin',
  'Cairo',
] as const;
const INDUSTRIES = [
  'banking',
  'insurance',
  'technology',
  'telecommunications',
  'retail',
  'healthcare',
  'manufacturing',
  'real_estate',
  'hospitality',
  'energy',
  'transportation',
  'consulting',
] as const;
const SOURCES = [
  'web',
  'phone_inquiry',
  'partner_referral',
  'customer_referral',
  'event',
  'advertisement',
  'social',
  'email',
] as const;
const RATINGS = ['hot', 'warm', 'cold'] as const;
/** Lead status mix: most leads are open or being worked (§4.3); none are converted here. */
const STATUSES = [
  'open',
  'open',
  'open',
  'working',
  'working',
  'nurture',
  'qualified',
  'unqualified',
] as const;
const UNQUALIFIED = ['no_budget', 'no_authority', 'no_need', 'bad_timing', 'unreachable'] as const;

const companyName = (r: () => number, i: number) =>
  `${pick(r, PREFIX)} ${pick(r, CORE)}${i % 7 === 0 ? ` ${String(1 + (i % 97))}` : ''}`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const money = (r: () => number, min: number, max: number) =>
  (Math.round((min + r() * (max - min)) / 100) * 100).toFixed(2);
const phone = (r: () => number) =>
  `+974 ${String(3000_0000 + Math.floor(r() * 6999_9999)).replace(/(\d{4})(\d{4})/, '$1 $2')}`;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface Pipeline {
  recordType: string;
  stages: { value: string; won: boolean; lost: boolean }[];
}

// ── Writing ─────────────────────────────────────────────────────────────────────────────────
export interface CrmSeedResult {
  created: CrmVolumes;
  skipped: boolean;
}

interface Ctx {
  prisma: CellPrisma;
  tenantId: string;
  ownerId: string;
  concurrency: number;
  log: (line: string) => void;
}

async function count(tx: TenantTransaction, table: string): Promise<number> {
  const r = await sql<{ n: string }>`SELECT count(*)::text AS n FROM ${sql.table(table)}`.execute(
    tx.kysely,
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** Write `total` records of an object in batches, resuming after the ones already there. */
async function write(
  c: Ctx,
  object: string,
  total: number,
  make: (i: number) => WriteInput,
  onCreated?: (ids: string[]) => void,
): Promise<number> {
  const existing = await withTenant(c.prisma, { tenantId: c.tenantId }, (tx) => count(tx, object));
  let created = 0;
  let failed = 0;
  let firstError = '';
  let ctx: RecordContext | null = null;
  const started = Date.now();
  const starts: number[] = [];
  for (let from = existing; from < total; from += BATCH) starts.push(from);
  // Batches run `concurrency` at a time, each in its own transaction (load scale).
  for (let w = 0; w < starts.length; w += c.concurrency) {
    const wave = starts.slice(w, w + c.concurrency);
    const outcomes = await Promise.all(
      wave.map(async (from) => {
        const inputs = Array.from({ length: Math.min(BATCH, total - from) }, (_, k) =>
          make(from + k),
        );
        // A batch of 200 through the full pipeline can outlast the request default (10 s) when
        // several run at once on a busy machine; a seed may wait longer.
        return retryOnConflict(() =>
          withTenant(
            c.prisma,
            { tenantId: c.tenantId, userId: c.ownerId },
            async (tx) => {
              // The context (metadata, permissions) is loaded once and reused across batches.
              ctx ??= await loadRecordContext(tx, c.ownerId);
              return bulkCreate(tx, ctx, object, inputs);
            },
            { timeoutMs: 120_000 },
          ),
        );
      }),
    );
    const ids: string[] = [];
    for (const r of outcomes.flat()) {
      if (r.ok) {
        created += 1;
        ids.push(r.id);
      } else {
        failed += 1;
        firstError ||= JSON.stringify(r.errors);
      }
    }
    onCreated?.(ids);
    const done = Math.min(total, (wave.at(-1) ?? existing) + BATCH);
    if (failed > Math.max(5, (done - existing) * MAX_FAILURE_RATE))
      throw new Error(
        `seeding ${object} failed: ${String(failed)} rows rejected, e.g. ${firstError}`,
      );
    if ((w / c.concurrency) % 25 === 0 && total > 5_000) {
      const rate = created / Math.max(1, (Date.now() - started) / 1000);
      c.log(`  ${object}: ${String(done)}/${String(total)} (${rate.toFixed(0)}/s)`);
    }
  }
  if (failed) c.log(`  ${object}: ${String(failed)} rows rejected, e.g. ${firstError}`);
  return created;
}

/** All ids of an object, oldest first (accounts for contacts and opportunities to point at). */
async function idsOf(c: Ctx, table: string): Promise<string[]> {
  return withTenant(c.prisma, { tenantId: c.tenantId }, async (tx) => {
    const r = await sql<{ id: string }>`SELECT id FROM ${sql.table(table)} ORDER BY id`.execute(
      tx.kysely,
    );
    return r.rows.map((row) => row.id);
  });
}

/**
 * The bank's three opportunity record types, each with its own pipeline (§4.5). Stage API values
 * reuse the standard ones, relabelled per line of business. Created once; idempotent by name.
 */
async function bankPipelines(c: Ctx): Promise<Pipeline[]> {
  const lines = [
    {
      apiName: 'retail_banking',
      name: 'Retail banking',
      stages: [
        ['qualification', 'Application', 'OPEN', 10],
        ['needs_analysis', 'KYC review', 'OPEN', 30],
        ['proposal', 'Offer made', 'OPEN', 60],
        ['closed_won', 'Funded', 'WON', 100],
        ['closed_lost', 'Declined', 'LOST', 0],
      ],
    },
    {
      apiName: 'corporate_banking',
      name: 'Corporate banking',
      stages: [
        ['qualification', 'Origination', 'OPEN', 10],
        ['needs_analysis', 'Credit analysis', 'OPEN', 25],
        ['proposal', 'Term sheet', 'OPEN', 50],
        ['negotiation', 'Legal and documentation', 'OPEN', 75],
        ['closed_won', 'Signed', 'WON', 100],
        ['closed_lost', 'Lost', 'LOST', 0],
      ],
    },
    {
      apiName: 'wealth_management',
      name: 'Wealth management',
      stages: [
        ['qualification', 'Discovery', 'OPEN', 15],
        ['proposal', 'Investment proposal', 'OPEN', 50],
        ['negotiation', 'Onboarding', 'OPEN', 80],
        ['closed_won', 'Invested', 'WON', 100],
        ['closed_lost', 'Lost', 'LOST', 0],
      ],
    },
  ] as const;
  return withTenant(c.prisma, { tenantId: c.tenantId, userId: c.ownerId }, async (tx) => {
    const { prisma } = tx;
    const object = await prisma.objectDefinition.findFirstOrThrow({
      where: { apiName: 'opportunity' },
      select: { id: true },
    });
    const out: Pipeline[] = [];
    let changed = false;
    for (const [order, line] of lines.entries()) {
      let pipeline = await prisma.pipeline.findFirst({ where: { name: line.name } });
      if (!pipeline) {
        changed = true;
        pipeline = await prisma.pipeline.create({
          data: { tenantId: c.tenantId, name: line.name, sortOrder: order + 1 },
        });
        await prisma.pipelineStage.createMany({
          data: line.stages.map(([apiValue, label, category, probability], i) => ({
            tenantId: c.tenantId,
            pipelineId: pipeline?.id ?? '',
            apiValue,
            label,
            sortOrder: i,
            category,
            probability,
            forecastCategory:
              category === 'WON' ? 'closed' : category === 'LOST' ? 'omitted' : 'pipeline',
          })),
        });
      }
      let rt = await prisma.recordType.findFirst({
        where: { objectId: object.id, apiName: line.apiName },
      });
      if (!rt) {
        changed = true;
        rt = await prisma.recordType.create({
          data: {
            tenantId: c.tenantId,
            objectId: object.id,
            apiName: line.apiName,
            name: line.name,
            pipelineId: pipeline.id,
          },
        });
      }
      out.push({
        recordType: rt.id,
        stages: line.stages.map(([value, , category]) => ({
          value,
          won: category === 'WON',
          lost: category === 'LOST',
        })),
      });
    }
    // New record types and pipelines are metadata: bump the version so caches reload (§3.10).
    if (changed)
      await prisma.tenantSettings.update({
        where: { tenantId: c.tenantId },
        data: { metadataVersion: { increment: 1 } },
      });
    return out;
  });
}

export async function seedCrm(
  prisma: CellPrisma,
  plan: SeedPlan,
  options: {
    tenantId: string;
    scale: 'demo' | 'load';
    log: (line: string) => void;
    /** Batches written at once; the load scale defaults to 4. */
    concurrency?: number;
    /** Overrides the scale's volumes (tests). */
    volumes?: CrmVolumes;
  },
): Promise<CrmSeedResult> {
  const volumes = options.volumes ?? CRM_VOLUMES[plan.scenario][options.scale];
  const concurrency = Math.max(1, options.concurrency ?? (options.scale === 'load' ? 4 : 1));
  const scenario = plan.scenario;
  const { tenantId } = options;
  // A workspace seeded before the current catalogue gets its standard objects first.
  await withTenant(prisma, { tenantId }, (tx) => syncStandardMetadata(tx));
  const people = await withTenant(prisma, { tenantId }, (tx) =>
    tx.prisma.user.findMany({ select: { id: true, email: true } }),
  );
  const idByEmail = new Map(people.map((p) => [p.email.toLowerCase(), p.id]));
  const ownerPlan = plan.users.find((u) => u.key === plan.owner);
  const ownerId = ownerPlan ? idByEmail.get(ownerPlan.email.toLowerCase()) : undefined;
  if (!ownerPlan || !ownerId) throw new Error(`the ${scenario} workspace has no owner to seed as`);
  // Records belong to the people who sell: everyone but the administrators.
  const owners = plan.users
    .filter((u) => u.profile !== ownerPlan.profile)
    .map((u) => idByEmail.get(u.email.toLowerCase()))
    .filter((id): id is string => Boolean(id));
  if (owners.length === 0) owners.push(ownerId);
  const c: Ctx = { prisma, tenantId, ownerId, concurrency, log: options.log };
  const ownerOf = (r: () => number) => pick(r, owners);
  const now = Date.UTC(2026, 9, 1);
  const domain = plan.workspace.slug.replace(/-demo$/, '');

  const pipelines = scenario === 'bank' ? await bankPipelines(c) : [];

  const accounts = await write(c, 'account', volumes.accounts, (i) => {
    const r = rngFor(scenario, 'account', i);
    const name = companyName(r, i);
    return {
      fields: {
        name,
        industry: pick(r, INDUSTRIES),
        rating: pick(r, RATINGS),
        type: pick(r, ['customer', 'prospect', 'partner'] as const),
        phone: phone(r),
        website: `https://${slug(name)}.example`,
        billing_city: pick(r, CITIES),
        annual_revenue: money(r, 500_000, 250_000_000),
        number_of_employees: 5 + Math.floor(r() * 5000),
        owner_id: ownerOf(r),
      },
    };
  });
  const accountIds = await idsOf(c, 'account');

  // Contacts and opportunities recompute their account's shares: batches that run together would
  // queue on the same accounts' share rows (random parents), so children go one batch at a time.
  const children: Ctx = { ...c, concurrency: 1 };
  const contacts = await write(children, 'contact', volumes.contacts, (i) => {
    const r = rngFor(scenario, 'contact', i);
    const first = pick(r, FIRST);
    const last = pick(r, LAST);
    return {
      fields: {
        first_name: first,
        last_name: last,
        title: pick(r, [
          'CEO',
          'CFO',
          'Head of Retail',
          'Operations Director',
          'Procurement Lead',
          'IT Manager',
          'Marketing Manager',
          'Treasurer',
        ] as const),
        email: `${slug(first)}.${slug(last)}${String(i)}@${domain}.example`,
        phone: phone(r),
        account_id: accountIds.length ? pick(r, accountIds) : null,
        owner_id: ownerOf(r),
      },
    };
  });

  const leads = await write(c, 'lead', volumes.leads, (i) => {
    const r = rngFor(scenario, 'lead', i);
    const first = pick(r, FIRST);
    const last = pick(r, LAST);
    const status = pick(r, STATUSES);
    return {
      fields: {
        first_name: first,
        last_name: last,
        company: companyName(r, i + 7),
        email: `${slug(first)}.${slug(last)}.${String(i)}@lead.example`,
        phone: phone(r),
        status,
        ...(status === 'unqualified' ? { unqualified_reason: pick(r, UNQUALIFIED) } : {}),
        rating: pick(r, RATINGS),
        lead_source: pick(r, SOURCES),
        industry: pick(r, INDUSTRIES),
        city: pick(r, CITIES),
        annual_revenue: money(r, 100_000, 50_000_000),
        owner_id: ownerOf(r),
      },
    };
  });

  const defaultStages = [
    'qualification',
    'needs_analysis',
    'proposal',
    'negotiation',
    'closed_won',
    'closed_lost',
  ] as const;
  const opportunities = await write(children, 'opportunity', volumes.opportunities, (i) => {
    const r = rngFor(scenario, 'opportunity', i);
    const pipeline = pipelines.length ? pipelines[i % pipelines.length] : undefined;
    const stage = pipeline ? pick(r, pipeline.stages).value : pick(r, defaultStages);
    const closed = stage === 'closed_won' || stage === 'closed_lost';
    // Closed deals closed in the past; open ones close in the coming months.
    const close = closed ? now - Math.floor(r() * 180) * DAY : now + Math.floor(r() * 180) * DAY;
    const account = accountIds.length ? pick(r, accountIds) : null;
    return {
      fields: {
        name: `${pick(r, PREFIX)} ${pick(r, [
          'renewal',
          'expansion',
          'new business',
          'pilot',
          'migration',
          'credit line',
          'mortgage',
          'portfolio',
        ] as const)} ${String(i + 1)}`,
        stage,
        close_date: isoDay(close),
        amount: money(r, 5_000, scenario === 'bank' ? 5_000_000 : 250_000),
        lead_source: pick(r, SOURCES),
        type: pick(r, ['new', 'upsell', 'renewal'] as const),
        // A lost deal says why (§4.5: loss reason is required on Closed Lost).
        ...(stage === 'closed_lost'
          ? { loss_reason: pick(r, ['price', 'competitor', 'no_decision', 'timing'] as const) }
          : {}),
        ...(account ? { account_id: account } : {}),
        ...(pipeline ? { record_type_id: pipeline.recordType } : {}),
        owner_id: ownerOf(r),
      },
    };
  });

  const created = { accounts, contacts, leads, opportunities };
  return { created, skipped: Object.values(created).every((n) => n === 0) };
}
