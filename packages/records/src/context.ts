import type { MetadataIndex } from '@sm/metadata';
import type { EffectivePermissions } from '@sm/permissions';
import type { SharingContext } from '@sm/query-engine';

/** Converts money to the corporate currency at a dated rate (Q13, ADR-0031; the service is T16). */
export interface CurrencyConverter {
  /**
   * `amount` (a decimal string) in `code` on `date` (`YYYY-MM-DD`), in the corporate currency.
   * Null when no rate is known on or before that date.
   */
  toCorporate(
    amount: string,
    code: string,
    date: string,
  ): Promise<{ amount: string; rateDate: string } | null>;
  /** Whether the organisation uses `code` (its corporate currency or an active one). */
  isActive(code: string): Promise<boolean>;
}

/** Extension points that later phases fill (§3.7 step 4). Duplicate rules are built in (P03). */
export interface RecordHooks {
  /** Before-save automation: field updates only, synchronous, bounded (P08). */
  beforeSave?(object: string, values: Record<string, unknown>, isNew: boolean): Promise<void>;
}

/** Who writes, and everything the pipeline needs to decide what they may write. */
export interface RecordContext {
  userId: string;
  metadata: MetadataIndex;
  permissions: EffectivePermissions;
  sharing: SharingContext;
  corporateCurrency: string;
  /** The writer's time zone, for TODAY() in validation rules and money dates. */
  timezone: string;
  currency: CurrencyConverter;
  /** `$User.*` and `$Org.*` in validation rules. */
  globals(scope: 'User' | 'Org', name: string): unknown;
  now?: () => Date;
  requestId?: string;
  hooks?: RecordHooks;
}
