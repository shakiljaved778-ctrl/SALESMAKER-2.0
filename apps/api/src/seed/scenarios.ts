import {
  DEFAULT_PROFILES,
  type DefaultProfileKey,
  type Grants,
  type ObjectAccess,
  type SystemPermissionName,
} from '@sm/permissions';

/**
 * Demo workspaces (§15, decision 37): the identity half — hierarchy, profiles, permission sets,
 * users, groups and queues. CRM records join in P02. Plans are pure and deterministic: the same
 * scenario always yields the same units, people, emails and assignments.
 */
export type ScenarioName = 'agency' | 'bank';

export interface SeedUnit {
  key: string;
  name: string;
  parent: string | null;
}

export interface SeedProfile {
  key: string;
  /** Built-in profiles keep their localised name; custom ones are named here. */
  builtIn?: DefaultProfileKey;
  name?: string;
  description?: string;
  grants?: Grants;
}

export interface SeedPermissionSet {
  key: string;
  name: string;
  description: string;
  grants: Grants;
}

export interface SeedUser {
  key: string;
  name: string;
  email: string;
  title: string;
  unit: string;
  manager: string | null;
  profile: string;
  permissionSets: string[];
  permissionSetGroups: string[];
  /** IANA zone when it differs from the workspace default. */
  timezone: string | null;
}

export type SeedMember =
  | { type: 'USER'; key: string }
  | { type: 'GROUP'; key: string }
  | { type: 'ORG_UNIT' | 'ORG_UNIT_AND_SUBORDINATES'; key: string };

export interface SeedPlan {
  scenario: ScenarioName;
  workspace: { name: string; slug: string; currency: string; timezone: string; locale: string };
  /** The first user; owns the workspace. */
  owner: string;
  units: SeedUnit[];
  profiles: SeedProfile[];
  permissionSets: SeedPermissionSet[];
  permissionSetGroups: { key: string; name: string; sets: string[]; muting: Grants | null }[];
  users: SeedUser[];
  groups: { key: string; name: string; members: SeedMember[] }[];
  queues: { key: string; name: string; email: string; objects: string[]; members: SeedMember[] }[];
}

// ── Grant helpers ──────────────────────────────────────────────────────────────────────────
const NONE: ObjectAccess = {
  read: false,
  create: false,
  edit: false,
  delete: false,
  viewAll: false,
  modifyAll: false,
};

function builtIn(key: DefaultProfileKey): Grants {
  const found = DEFAULT_PROFILES.find((p) => p.key === key);
  if (!found) throw new Error(`no built-in profile ${key}`);
  return structuredClone(found.grants);
}

/** A built-in profile's grants with system permissions added and object access adjusted. */
function derive(
  base: DefaultProfileKey,
  change: {
    add?: SystemPermissionName[];
    remove?: SystemPermissionName[];
    objects?: (object: string, access: ObjectAccess) => ObjectAccess;
  },
): Grants {
  const grants = builtIn(base);
  grants.system = [
    ...new Set([
      ...grants.system.filter((s) => !change.remove?.includes(s)),
      ...(change.add ?? []),
    ]),
  ].sort();
  if (change.objects)
    for (const [object, access] of Object.entries(grants.objects))
      if (access) grants.objects[object] = change.objects(object, access);
  return grants;
}

const systemOnly = (...system: SystemPermissionName[]): Grants => ({
  system,
  objects: {},
  fields: {},
});

// ── Deterministic names ────────────────────────────────────────────────────────────────────
/** mulberry32: a tiny seeded PRNG, so generated people never change between runs. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const FIRST = [
  'Aisha',
  'Omar',
  'Fatima',
  'Yousef',
  'Mariam',
  'Khalid',
  'Noor',
  'Hamad',
  'Layla',
  'Tariq',
  'Sara',
  'Rashid',
  'Huda',
  'Faisal',
  'Amira',
  'Nasser',
  'Dana',
  'Salman',
  'Reem',
  'Adel',
  'Priya',
  'Arjun',
  'Maria',
  'James',
  'Grace',
  'Daniel',
  'Elena',
  'Samuel',
  'Leila',
  'Kofi',
];
const LAST = [
  'Al-Sayed',
  'Haddad',
  'Rahman',
  'Qureshi',
  'Mansour',
  'Farouk',
  'Nasser',
  'Khoury',
  'Aziz',
  'Hassan',
  'Saleh',
  'Ibrahim',
  'Karim',
  'Nair',
  'Fernandes',
  'Mensah',
  'Okafor',
  'Silva',
  'Petrova',
  'Walker',
  'Chen',
  'Santos',
  'Menon',
  'Osei',
];

function people(seed: number) {
  const next = prng(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  let n = 0;
  return (domain: string) => {
    n += 1;
    const first = pick(FIRST);
    const last = pick(LAST);
    const local = `${first}.${last}`.toLowerCase().replace(/[^a-z.]/g, '');
    return { name: `${first} ${last}`, email: `${local}.${String(n).padStart(3, '0')}@${domain}` };
  };
}

// ── Pixelcraft Studio: a 5-rep agency ──────────────────────────────────────────────────────
function agency(): SeedPlan {
  const domain = 'pixelcraft.example';
  const user = (
    key: string,
    name: string,
    title: string,
    unit: string,
    manager: string | null,
    profile: string,
    permissionSets: string[] = [],
  ): SeedUser => ({
    key,
    name,
    email: `${name.split(' ')[0]?.toLowerCase() ?? key}@${domain}`,
    title,
    unit,
    manager,
    profile,
    permissionSets,
    permissionSetGroups: [],
    timezone: null,
  });
  return {
    scenario: 'agency',
    workspace: {
      name: 'Pixelcraft Studio (Demo)',
      slug: 'pixelcraft-demo',
      currency: 'USD',
      timezone: 'UTC',
      locale: 'en',
    },
    owner: 'owner',
    units: [
      { key: 'studio', name: 'Pixelcraft Studio', parent: null },
      { key: 'sales', name: 'Sales', parent: 'studio' },
    ],
    profiles: [
      { key: 'admin', builtIn: 'system_administrator' },
      { key: 'standard', builtIn: 'standard_user' },
      { key: 'readonly', builtIn: 'read_only' },
      {
        key: 'manager',
        name: 'Sales Manager',
        description: 'Runs the sales team: reports, dashboards and record transfers.',
        grants: derive('standard_user', {
          add: ['export_reports', 'manage_dashboards', 'transfer_records', 'mass_update'],
        }),
      },
    ],
    permissionSets: [
      {
        key: 'accounts',
        name: 'Account management',
        description: 'For reps who also manage existing client accounts.',
        grants: {
          system: ['transfer_records', 'export_reports'],
          objects: {
            account: { ...NONE, read: true, create: true, edit: true, delete: true, viewAll: true },
            contact: { ...NONE, read: true, create: true, edit: true, delete: true, viewAll: true },
          },
          fields: {},
        },
      },
    ],
    permissionSetGroups: [],
    users: [
      user('owner', 'Maya Chen', 'Founder', 'studio', null, 'admin'),
      user('manager', 'Omar Haddad', 'Head of Sales', 'sales', 'owner', 'manager'),
      user('lina', 'Lina Park', 'Account Executive', 'sales', 'manager', 'standard'),
      user('jonas', 'Jonas Weber', 'Account Executive', 'sales', 'manager', 'standard'),
      user(
        'priya',
        'Priya Nair',
        'Account Executive & Account Manager',
        'sales',
        'manager',
        'standard',
        ['accounts'],
      ),
      user('diego', 'Diego Santos', 'Business Development Rep', 'sales', 'manager', 'standard'),
    ],
    groups: [
      { key: 'sales', name: 'Everyone in sales', members: [{ type: 'ORG_UNIT', key: 'sales' }] },
    ],
    queues: [
      {
        key: 'web',
        name: 'Website enquiries',
        email: `hello@${domain}`,
        objects: ['lead'],
        members: [{ type: 'GROUP', key: 'sales' }],
      },
    ],
  };
}

// ── Aurelia Bank: an 800-rep retail sales floor ────────────────────────────────────────────
const REGIONS = ['North', 'South', 'East', 'West'] as const;
const TEAMS = ['A', 'B', 'C', 'D'] as const;
export const BANK_SHAPE = { regions: 4, branchesPerRegion: 5, teamsPerBranch: 4, repsPerTeam: 10 };

function bank(): SeedPlan {
  const domain = 'aurelia-bank.example';
  const person = people(0xa0be11a);
  const users: SeedUser[] = [];
  const add = (
    key: string,
    title: string,
    unit: string,
    manager: string | null,
    profile: string,
    extra: Partial<Pick<SeedUser, 'permissionSets' | 'permissionSetGroups' | 'timezone'>> = {},
  ) => {
    users.push({
      key,
      ...person(domain),
      title,
      unit,
      manager,
      profile,
      permissionSets: extra.permissionSets ?? [],
      permissionSetGroups: extra.permissionSetGroups ?? [],
      timezone: extra.timezone ?? null,
    });
  };
  const units: SeedUnit[] = [
    { key: 'company', name: 'Aurelia Bank Retail Sales', parent: null },
    { key: 'compliance', name: 'Compliance', parent: 'company' },
    { key: 'hub', name: 'Central Telesales Hub', parent: 'company' },
  ];
  add('admin', 'Head of Sales Operations', 'company', null, 'admin');
  add('compliance-1', 'Compliance Officer', 'compliance', 'admin', 'compliance');
  add('compliance-2', 'Compliance Officer', 'compliance', 'admin', 'compliance');

  REGIONS.forEach((region, r) => {
    const regionKey = `region-${String(r + 1)}`;
    // The West region serves customers across the Gulf from Dubai.
    const timezone = region === 'West' ? 'Asia/Dubai' : null;
    units.push({ key: regionKey, name: `${region} Region`, parent: 'company' });
    add(`${regionKey}-director`, `Regional Director, ${region}`, regionKey, 'admin', 'director', {
      permissionSetGroups: ['branch-ops'],
      timezone,
    });
    for (let b = 1; b <= BANK_SHAPE.branchesPerRegion; b += 1) {
      const branchKey = `${regionKey}-branch-${String(b)}`;
      units.push({ key: branchKey, name: `${region} Branch ${String(b)}`, parent: regionKey });
      add(`${branchKey}-manager`, 'Branch Manager', branchKey, `${regionKey}-director`, 'branch', {
        permissionSets: ['bulk'],
        timezone,
      });
      TEAMS.forEach((team, t) => {
        const teamKey = `${branchKey}-team-${team.toLowerCase()}`;
        units.push({
          key: teamKey,
          name: `${region} ${String(b)} Team ${team}`,
          parent: branchKey,
        });
        add(`${teamKey}-leader`, 'Team Leader', teamKey, `${branchKey}-manager`, 'leader', {
          timezone,
        });
        // Teams A and B dial (telesales); C and D look after existing customers.
        const telesales = t < 2;
        for (let n = 1; n <= BANK_SHAPE.repsPerTeam; n += 1)
          add(
            `${teamKey}-rep-${String(n)}`,
            telesales ? 'Telesales Agent' : 'Relationship Officer',
            teamKey,
            `${teamKey}-leader`,
            telesales ? 'agent' : 'officer',
            { timezone },
          );
      });
    }
  });

  add('hub-manager', 'Telesales Hub Manager', 'hub', 'admin', 'branch', {
    permissionSets: ['bulk', 'after-hours'],
  });
  for (const shift of ['early', 'late'] as const) {
    const unit = `hub-${shift}`;
    units.push({
      key: unit,
      name: `Hub ${shift === 'early' ? 'Early' : 'Late'} Shift`,
      parent: 'hub',
    });
    add(`${unit}-leader`, 'Team Leader', unit, 'hub-manager', 'leader');
    for (let n = 1; n <= 10; n += 1)
      add(`${unit}-agent-${String(n)}`, 'Telesales Agent', unit, `${unit}-leader`, 'agent', {
        // The late shift works for the London desk.
        timezone: shift === 'late' ? 'Europe/London' : null,
      });
  }

  const noDelete = (_: string, a: ObjectAccess): ObjectAccess => ({
    ...a,
    delete: false,
    modifyAll: false,
  });
  return {
    scenario: 'bank',
    workspace: {
      name: 'Aurelia Bank Retail Sales (Demo)',
      slug: 'aurelia-demo',
      currency: 'QAR',
      timezone: 'Asia/Qatar',
      locale: 'en',
    },
    owner: 'admin',
    units,
    profiles: [
      { key: 'admin', builtIn: 'system_administrator' },
      { key: 'standard', builtIn: 'standard_user' },
      { key: 'readonly', builtIn: 'read_only' },
      {
        key: 'director',
        name: 'Director',
        description: 'Leads a region: every report and dashboard, wallboards and exports.',
        grants: derive('standard_user', {
          add: ['export_reports', 'manage_dashboards', 'view_wallboard', 'transfer_records'],
        }),
      },
      {
        key: 'branch',
        name: 'Branch Manager',
        description: 'Runs a branch: dashboards, wallboards and reassigning work.',
        grants: derive('standard_user', {
          add: ['manage_dashboards', 'view_wallboard', 'transfer_records'],
        }),
      },
      {
        key: 'leader',
        name: 'Team Leader',
        description: 'Coaches a team of ten: wallboards and reassigning the team’s work.',
        grants: derive('standard_user', { add: ['view_wallboard', 'transfer_records'] }),
      },
      {
        key: 'agent',
        name: 'Telesales Agent',
        description: 'Works leads by phone; cannot delete records.',
        grants: derive('standard_user', { objects: noDelete }),
      },
      {
        key: 'officer',
        name: 'Relationship Officer',
        description: 'Looks after existing customers and their applications.',
        grants: derive('standard_user', {}),
      },
      {
        key: 'compliance',
        name: 'Compliance Viewer',
        description: 'Reads everything for review and audit; changes nothing.',
        grants: derive('read_only', { add: ['view_all_data', 'view_setup', 'export_reports'] }),
      },
    ],
    permissionSets: [
      {
        key: 'bulk',
        name: 'Bulk data',
        description: 'Imports and mass updates.',
        grants: systemOnly('import_records', 'mass_update'),
      },
      {
        key: 'automation',
        name: 'Automation builder',
        description: 'Builds and runs automations.',
        grants: systemOnly('manage_automations', 'export_reports'),
      },
      {
        key: 'after-hours',
        name: 'After-hours dialling',
        description: 'May call outside the calling window (regulated; assign deliberately).',
        grants: systemOnly('bypass_calling_window'),
      },
    ],
    permissionSetGroups: [
      {
        key: 'branch-ops',
        name: 'Regional operations',
        sets: ['bulk', 'automation'],
        // Directors never export from the automation set's grant.
        muting: systemOnly('export_reports'),
      },
    ],
    users,
    groups: [
      {
        key: 'directors',
        name: 'Regional directors',
        members: REGIONS.map((_, r) => ({ type: 'USER', key: `region-${String(r + 1)}-director` })),
      },
      {
        key: 'compliance',
        name: 'Compliance',
        members: [{ type: 'ORG_UNIT', key: 'compliance' }],
      },
      {
        key: 'leadership',
        name: 'Leadership',
        members: [
          { type: 'GROUP', key: 'directors' },
          { type: 'USER', key: 'admin' },
          { type: 'USER', key: 'hub-manager' },
        ],
      },
      {
        key: 'floor',
        name: 'Telesales floor',
        members: [{ type: 'ORG_UNIT_AND_SUBORDINATES', key: 'hub' }],
      },
    ],
    queues: [
      ...REGIONS.map((region, r) => ({
        key: `inbound-${String(r + 1)}`,
        name: `${region} Region inbound`,
        email: `inbound.${region.toLowerCase()}@${domain}`,
        objects: ['lead'],
        members: [{ type: 'ORG_UNIT_AND_SUBORDINATES' as const, key: `region-${String(r + 1)}` }],
      })),
      {
        key: 'callbacks',
        name: 'Hub callbacks',
        email: `callbacks@${domain}`,
        objects: ['lead', 'activity'],
        members: [{ type: 'GROUP', key: 'floor' }],
      },
    ],
  };
}

export function seedPlan(scenario: ScenarioName): SeedPlan {
  return scenario === 'agency' ? agency() : bank();
}
