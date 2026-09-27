import { camelCase, LEAD_STATUS_CATEGORIES } from './catalogue.js';
import type { StandardObjectApiName } from './types.js';

/**
 * Revision of the standard metadata a tenant is provisioned with (P02). Bump it whenever the
 * catalogue or these defaults change what is synced; tenants behind it are synced on next use.
 */
export const CATALOGUE_VERSION = 2;

/** Standard objects whose tables and metadata exist so far; later phases add theirs. */
export const METADATA_OBJECTS: readonly StandardObjectApiName[] = [
  'lead',
  'account',
  'contact',
  'opportunity',
  'campaign',
];

/** Named value sets shared by several standard picklists; labels live under `picklists.<set>`. */
const VALUE_SETS = {
  leadStatus: LEAD_STATUS_CATEGORIES.map((c) => c.toLowerCase()),
  unqualifiedReason: [
    'no_budget',
    'no_authority',
    'no_need',
    'bad_timing',
    'went_with_competitor',
    'unreachable',
    'duplicate',
    'other',
  ],
  rating: ['hot', 'warm', 'cold'],
  leadSource: [
    'web',
    'phone_inquiry',
    'partner_referral',
    'customer_referral',
    'event',
    'advertisement',
    'social',
    'email',
    'other',
  ],
  industry: [
    'banking',
    'insurance',
    'technology',
    'telecommunications',
    'retail',
    'healthcare',
    'manufacturing',
    'real_estate',
    'education',
    'government',
    'hospitality',
    'media',
    'energy',
    'transportation',
    'consulting',
    'other',
  ],
  accountType: ['prospect', 'customer', 'partner', 'competitor', 'other'],
  forecastCategory: ['pipeline', 'best_case', 'commit', 'closed', 'omitted'],
  opportunityType: ['new', 'upsell', 'renewal'],
  lossReason: ['price', 'competitor', 'no_decision', 'timing', 'product_fit', 'other'],
  campaignType: [
    'email',
    'event',
    'webinar',
    'advertisement',
    'social',
    'direct_mail',
    'partner',
    'other',
  ],
  campaignStatus: ['planned', 'in_progress', 'completed', 'aborted'],
} as const;
export type ValueSetName = keyof typeof VALUE_SETS;

/** Which value set each standard picklist starts with. Fields not listed start empty. */
const PICKLIST_SETS: Partial<Record<StandardObjectApiName, Record<string, ValueSetName>>> = {
  lead: {
    status: 'leadStatus',
    unqualified_reason: 'unqualifiedReason',
    rating: 'rating',
    lead_source: 'leadSource',
    industry: 'industry',
  },
  account: { type: 'accountType', industry: 'industry', rating: 'rating' },
  contact: { lead_source: 'leadSource' },
  opportunity: {
    forecast_category: 'forecastCategory',
    type: 'opportunityType',
    lead_source: 'leadSource',
    loss_reason: 'lossReason',
  },
  campaign: { type: 'campaignType', status: 'campaignStatus' },
};

/** Sets whose values carry a system category (lead status §4.3, forecast category §4.5). */
const CATEGORY_SETS = new Set<ValueSetName>(['leadStatus', 'forecastCategory']);

export interface DefaultPicklistValue {
  apiValue: string;
  /** i18n key of the label (`picklists.<set>.<camelValue>`). */
  labelKey: string;
  /** System category (lead status, forecast category); admins rename labels, not categories. */
  category?: string;
  isDefault: boolean;
}

/**
 * The values a standard picklist starts with. Stored values are lower snake_case; lead statuses
 * also carry their system category, which reports and AI use (§4.3).
 */
export function defaultPicklistValues(
  object: StandardObjectApiName,
  field: string,
): DefaultPicklistValue[] {
  const set = PICKLIST_SETS[object]?.[field];
  if (!set) return [];
  return VALUE_SETS[set].map((apiValue, i) => ({
    apiValue,
    labelKey: `picklists.${set}.${camelCase(apiValue)}`,
    ...(CATEGORY_SETS.has(set) ? { category: apiValue.toUpperCase() } : {}),
    isDefault: i === 0 && (set === 'leadStatus' || set === 'forecastCategory'),
  }));
}

/** Every label key the defaults use, for the i18n catalogue check. */
export function picklistLabelKeys(): string[] {
  return Object.entries(VALUE_SETS).flatMap(([set, values]) =>
    values.map((v) => `picklists.${set}.${camelCase(v)}`),
  );
}

/** Compact layout (§5.4, ≤ 7 fields): the Highlights Panel and cards. */
export const DEFAULT_COMPACT_FIELDS: Record<string, readonly string[]> = {
  lead: ['last_name', 'company', 'status', 'email', 'phone', 'owner_id'],
  account: ['name', 'type', 'industry', 'phone', 'website', 'owner_id'],
  contact: ['last_name', 'account_id', 'title', 'email', 'phone', 'owner_id'],
  opportunity: ['name', 'account_id', 'stage', 'amount', 'close_date', 'owner_id'],
  campaign: ['name', 'type', 'status', 'start_date', 'end_date', 'owner_id'],
};

/** Fields searched by default (§7.19: name, email, phone, company). */
export const DEFAULT_SEARCHABLE: Record<string, readonly string[]> = {
  lead: ['first_name', 'last_name', 'company', 'email', 'phone', 'mobile_phone'],
  account: ['name', 'phone', 'website'],
  contact: ['first_name', 'last_name', 'email', 'phone', 'mobile_phone'],
  opportunity: ['name'],
  campaign: ['name'],
};

export interface LayoutSection {
  key: string;
  /** i18n key of the section title. */
  labelKey: string;
  columns: 1 | 2;
  fields: { field: string }[];
}

const ADDRESS = /(^|_)(street|city|state|postal_code|country)$/;
const SYSTEM_SECTION = ['record_number', 'created_by', 'created_at', 'updated_by', 'updated_at'];

/**
 * The page layout every standard object starts with: details, address, description and system
 * information, in catalogue order. Admins edit it in the layout editor (§5.4).
 */
export function defaultLayoutSections(
  fields: readonly { apiName: string; type: string; system: boolean }[],
): LayoutSection[] {
  const shown = fields.filter((f) => f.type !== 'id' && f.type !== 'rollup_summary');
  const details = shown.filter(
    (f) =>
      !f.system &&
      !ADDRESS.test(f.apiName) &&
      f.type !== 'long_text' &&
      f.apiName !== 'external_id',
  );
  const address = shown.filter((f) => ADDRESS.test(f.apiName));
  const text = shown.filter((f) => f.type === 'long_text');
  const system = SYSTEM_SECTION.filter((name) => shown.some((f) => f.apiName === name));
  const section = (key: string, columns: 1 | 2, names: string[]): LayoutSection => ({
    key,
    labelKey: `layouts.sections.${key}`,
    columns,
    fields: names.map((field) => ({ field })),
  });
  return [
    section(
      'details',
      2,
      details.map((f) => f.apiName),
    ),
    ...(address.length
      ? [
          section(
            'address',
            2,
            address.map((f) => f.apiName),
          ),
        ]
      : []),
    ...(text.length
      ? [
          section(
            'description',
            1,
            text.map((f) => f.apiName),
          ),
        ]
      : []),
    section('system', 2, system),
  ];
}

/** The pipeline every organisation starts with (§4.5); stage labels are `…pipeline.stages.<key>`. */
export const DEFAULT_PIPELINE_STAGES: readonly {
  apiValue: string;
  category: 'OPEN' | 'WON' | 'LOST';
  probability: number;
  forecastCategory: string;
}[] = [
  { apiValue: 'qualification', category: 'OPEN', probability: 10, forecastCategory: 'pipeline' },
  { apiValue: 'needs_analysis', category: 'OPEN', probability: 25, forecastCategory: 'pipeline' },
  { apiValue: 'proposal', category: 'OPEN', probability: 50, forecastCategory: 'best_case' },
  { apiValue: 'negotiation', category: 'OPEN', probability: 75, forecastCategory: 'commit' },
  { apiValue: 'closed_won', category: 'WON', probability: 100, forecastCategory: 'closed' },
  { apiValue: 'closed_lost', category: 'LOST', probability: 0, forecastCategory: 'omitted' },
];
