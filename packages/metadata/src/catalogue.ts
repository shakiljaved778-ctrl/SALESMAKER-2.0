import type {
  FieldType,
  ReferenceTarget,
  SharingModel,
  StandardField,
  StandardObject,
  StandardObjectApiName,
} from './types.js';

/** `close_date` → `closeDate`: i18n key segments are camelCase. */
export function camelCase(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

interface FieldOptions {
  required?: boolean;
  system?: boolean;
  references?: readonly ReferenceTarget[];
  values?: readonly string[];
}

function builder(object: StandardObjectApiName) {
  return (apiName: string, type: FieldType, options: FieldOptions = {}): StandardField => ({
    apiName,
    type,
    labelKey: `objects.${camelCase(object)}.fields.${camelCase(apiName)}`,
    system: options.system ?? false,
    required: options.required ?? false,
    ...(options.references ? { references: options.references } : {}),
    ...(options.values ? { values: options.values } : {}),
  });
}

/** Columns every CRM object carries (§4.1); labels are shared under `objects.common`. */
function commonFields(owner: readonly ReferenceTarget[]): StandardField[] {
  const f = (apiName: string, type: FieldType, options: FieldOptions = {}): StandardField => ({
    apiName,
    type,
    labelKey: `objects.common.fields.${camelCase(apiName)}`,
    system: options.system ?? false,
    required: options.required ?? false,
    ...(options.references ? { references: options.references } : {}),
  });
  return [
    f('id', 'id', { system: true }),
    f('record_number', 'auto_number', { system: true }),
    // Owner is required but assigned by the platform when omitted (creator or assignment rules).
    f('owner_id', 'lookup', { required: true, references: owner }),
    f('record_type_id', 'lookup', { references: ['record_type'] }),
    f('external_id', 'text'),
    f('created_at', 'datetime', { system: true }),
    f('created_by', 'user', { system: true, references: ['user'] }),
    f('updated_at', 'datetime', { system: true }),
    f('updated_by', 'user', { system: true, references: ['user'] }),
  ];
}

const ALL_FEATURES = { activities: true, history: true, search: true, reports: true, api: true };

function object(
  apiName: StandardObjectApiName,
  meta: {
    icon: string;
    color: StandardObject['color'];
    prefix: string;
    nameField: string;
    sharing: SharingModel;
    allowed?: readonly SharingModel[];
    parentFields?: readonly string[];
    owner?: readonly ReferenceTarget[];
    features?: Partial<StandardObject['features']>;
  },
  fields: (f: ReturnType<typeof builder>) => StandardField[],
): StandardObject {
  const parentFields = meta.parentFields ?? [];
  return {
    apiName,
    labelKey: {
      singular: `objects.${camelCase(apiName)}.singular`,
      plural: `objects.${camelCase(apiName)}.plural`,
    },
    icon: meta.icon,
    color: meta.color,
    recordNumberPrefix: meta.prefix,
    nameField: meta.nameField,
    sharing: {
      default: meta.sharing,
      allowed: meta.allowed ?? [
        'PRIVATE',
        'PUBLIC_READ',
        'PUBLIC_READ_WRITE',
        ...(parentFields.length ? (['CONTROLLED_BY_PARENT'] as const) : []),
      ],
      parentFields,
      hierarchyAccess: true,
    },
    features: { ...ALL_FEATURES, ...meta.features },
    fields: [...commonFields(meta.owner ?? ['user', 'queue']), ...fields(builder(apiName))],
  };
}

/** Lead status system categories (§4.3); admins rename labels, reports and AI use these. */
export const LEAD_STATUS_CATEGORIES = [
  'OPEN',
  'WORKING',
  'NURTURE',
  'QUALIFIED',
  'UNQUALIFIED',
  'CONVERTED',
] as const;
/** Opportunity forecast categories (§4.5). */
export const FORECAST_CATEGORIES = [
  'PIPELINE',
  'BEST_CASE',
  'COMMIT',
  'CLOSED',
  'OMITTED',
] as const;
/** Activity types (§4.2). */
export const ACTIVITY_TYPES = [
  'task',
  'call',
  'meeting',
  'email',
  'whatsapp',
  'sms',
  'note',
  'system',
] as const;

const address = (f: ReturnType<typeof builder>, prefix: string) => [
  f(`${prefix}street`, 'textarea'),
  f(`${prefix}city`, 'text'),
  f(`${prefix}state`, 'text'),
  f(`${prefix}postal_code`, 'text'),
  f(`${prefix}country`, 'text'),
];

/**
 * The standard objects (§5.1) with their standard fields and sharing defaults (§6.3). Read-only:
 * P02 seeds `object_definition` / `field_definition` from this list, and permissions (§6.2)
 * reference objects and fields by these API names, so an API name here never changes.
 */
export const STANDARD_OBJECTS: readonly StandardObject[] = [
  object(
    'lead',
    {
      icon: 'user-round-plus',
      color: 'cobalt',
      prefix: 'L',
      nameField: 'last_name',
      sharing: 'PRIVATE',
    },
    (f) => [
      f('first_name', 'text'),
      f('last_name', 'text', { required: true }),
      f('company', 'text', { required: true }),
      f('title', 'text'),
      f('email', 'email'),
      f('phone', 'phone'),
      f('mobile_phone', 'phone'),
      f('website', 'url'),
      f('status', 'picklist', { required: true, values: LEAD_STATUS_CATEGORIES }),
      f('unqualified_reason', 'picklist'),
      f('rating', 'picklist'),
      f('lead_source', 'picklist'),
      f('industry', 'picklist'),
      f('annual_revenue', 'currency'),
      f('number_of_employees', 'number'),
      ...address(f, ''),
      f('description', 'long_text'),
      f('campaign_id', 'lookup', { references: ['campaign'] }),
      f('do_not_call', 'checkbox'),
      f('email_opt_out', 'checkbox'),
      f('converted_at', 'datetime', { system: true }),
      f('converted_account_id', 'lookup', { system: true, references: ['account'] }),
      f('converted_contact_id', 'lookup', { system: true, references: ['contact'] }),
      f('converted_opportunity_id', 'lookup', { system: true, references: ['opportunity'] }),
    ],
  ),
  object(
    'account',
    { icon: 'building-2', color: 'jade', prefix: 'A', nameField: 'name', sharing: 'PRIVATE' },
    (f) => [
      f('name', 'text', { required: true }),
      f('parent_account_id', 'lookup', { references: ['account'] }),
      f('type', 'picklist'),
      f('industry', 'picklist'),
      f('rating', 'picklist'),
      f('annual_revenue', 'currency'),
      f('number_of_employees', 'number'),
      f('website', 'url'),
      f('phone', 'phone'),
      ...address(f, 'billing_'),
      ...address(f, 'shipping_'),
      f('description', 'long_text'),
    ],
  ),
  object(
    'contact',
    {
      icon: 'contact-round',
      color: 'cyan',
      prefix: 'C',
      nameField: 'last_name',
      sharing: 'CONTROLLED_BY_PARENT',
      // The primary account controls access; contacts without one fall back to owner +
      // hierarchy (§6.3, v1.3).
      parentFields: ['account_id'],
    },
    (f) => [
      f('first_name', 'text'),
      f('last_name', 'text', { required: true }),
      f('account_id', 'lookup', { references: ['account'] }),
      f('title', 'text'),
      f('department', 'text'),
      f('email', 'email'),
      f('phone', 'phone'),
      f('mobile_phone', 'phone'),
      f('reports_to_id', 'lookup', { references: ['contact'] }),
      f('lead_source', 'picklist'),
      f('birthdate', 'date'),
      ...address(f, 'mailing_'),
      f('description', 'long_text'),
      f('do_not_call', 'checkbox'),
      f('email_opt_out', 'checkbox'),
    ],
  ),
  object(
    'opportunity',
    {
      icon: 'target',
      color: 'amber',
      prefix: 'O',
      nameField: 'name',
      sharing: 'PRIVATE',
      // "Opportunity → Account optional" (§6.3): an admin may switch it to the account.
      parentFields: ['account_id'],
    },
    (f) => [
      f('name', 'text', { required: true }),
      f('account_id', 'lookup', { references: ['account'] }),
      f('primary_contact_id', 'lookup', { references: ['contact'] }),
      f('pipeline_id', 'lookup', { required: true, references: ['pipeline'] }),
      f('stage', 'picklist', { required: true }),
      f('probability', 'percent'),
      f('forecast_category', 'picklist', { required: true, values: FORECAST_CATEGORIES }),
      f('amount', 'currency'),
      f('close_date', 'date', { required: true }),
      f('next_step', 'text'),
      f('type', 'picklist', { values: ['NEW', 'UPSELL', 'RENEWAL'] }),
      f('lead_source', 'picklist'),
      f('campaign_id', 'lookup', { references: ['campaign'] }),
      f('loss_reason', 'picklist'),
      f('competitors', 'multi_picklist'),
      f('description', 'long_text'),
      f('is_closed', 'checkbox', { system: true }),
      f('is_won', 'checkbox', { system: true }),
    ],
  ),
  object(
    'campaign',
    { icon: 'megaphone', color: 'rose', prefix: 'CP', nameField: 'name', sharing: 'PUBLIC_READ' },
    (f) => [
      f('name', 'text', { required: true }),
      f('parent_campaign_id', 'lookup', { references: ['campaign'] }),
      f('type', 'picklist'),
      f('status', 'picklist'),
      f('is_active', 'checkbox'),
      f('start_date', 'date'),
      f('end_date', 'date'),
      f('budgeted_cost', 'currency'),
      f('actual_cost', 'currency'),
      f('expected_revenue', 'currency'),
      f('description', 'long_text'),
      f('number_of_leads', 'rollup_summary', { system: true }),
      f('number_of_opportunities', 'rollup_summary', { system: true }),
    ],
  ),
  object(
    'product',
    {
      icon: 'package',
      color: 'graphite',
      prefix: 'P',
      nameField: 'name',
      sharing: 'PUBLIC_READ',
      features: { activities: false },
    },
    (f) => [
      f('name', 'text', { required: true }),
      f('product_code', 'text'),
      f('family', 'picklist'),
      f('quantity_unit', 'picklist'),
      f('is_active', 'checkbox'),
      f('description', 'long_text'),
    ],
  ),
  object(
    'quote',
    {
      icon: 'file-text',
      color: 'olive',
      prefix: 'Q',
      nameField: 'name',
      sharing: 'CONTROLLED_BY_PARENT',
      allowed: ['CONTROLLED_BY_PARENT'],
      parentFields: ['opportunity_id'],
    },
    (f) => [
      f('name', 'text', { required: true }),
      f('opportunity_id', 'master_detail', { required: true, references: ['opportunity'] }),
      f('status', 'picklist'),
      f('expiration_date', 'date'),
      f('subtotal', 'currency', { system: true }),
      f('discount', 'percent'),
      f('total_price', 'currency', { system: true }),
      f('description', 'long_text'),
    ],
  ),
  object(
    'contract',
    {
      icon: 'file-signature',
      color: 'graphite',
      prefix: 'CT',
      nameField: 'contract_number',
      sharing: 'PRIVATE',
    },
    (f) => [
      f('contract_number', 'auto_number', { system: true }),
      f('account_id', 'lookup', { required: true, references: ['account'] }),
      f('status', 'picklist'),
      f('start_date', 'date'),
      f('term_months', 'number'),
      f('end_date', 'date', { system: true }),
      f('description', 'long_text'),
    ],
  ),
  object(
    'order',
    {
      icon: 'shopping-cart',
      color: 'clay',
      prefix: 'OR',
      nameField: 'order_number',
      sharing: 'PRIVATE',
    },
    (f) => [
      f('order_number', 'auto_number', { system: true }),
      f('account_id', 'lookup', { required: true, references: ['account'] }),
      f('opportunity_id', 'lookup', { references: ['opportunity'] }),
      f('contract_id', 'lookup', { references: ['contract'] }),
      f('status', 'picklist'),
      f('effective_date', 'date', { required: true }),
      f('total_amount', 'currency', { system: true }),
      f('description', 'long_text'),
    ],
  ),
  object(
    'activity',
    {
      icon: 'list-checks',
      color: 'graphite',
      prefix: 'T',
      nameField: 'subject',
      sharing: 'CONTROLLED_BY_PARENT',
      allowed: ['CONTROLLED_BY_PARENT'],
      // Access follows the related record ("what") and the person ("who").
      parentFields: ['what_id', 'who_id'],
      owner: ['user'],
      features: { activities: false, history: false },
    },
    (f) => [
      f('type', 'picklist', { required: true, values: ACTIVITY_TYPES }),
      f('subject', 'text', { required: true }),
      f('status', 'picklist'),
      f('priority', 'picklist'),
      f('due_date', 'date'),
      f('start_at', 'datetime'),
      f('end_at', 'datetime'),
      f('what_id', 'lookup', {
        references: ['account', 'opportunity', 'campaign', 'quote', 'contract', 'order'],
      }),
      f('who_id', 'lookup', { references: ['lead', 'contact'] }),
      f('description', 'long_text'),
      f('completed_at', 'datetime', { system: true }),
    ],
  ),
];
