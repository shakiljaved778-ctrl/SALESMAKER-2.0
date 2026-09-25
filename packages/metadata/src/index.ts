import { STANDARD_OBJECTS } from './catalogue.js';
import type {
  SharingModel,
  StandardField,
  StandardObject,
  StandardObjectApiName,
} from './types.js';

export {
  ACTIVITY_TYPES,
  camelCase,
  FORECAST_CATEGORIES,
  LEAD_STATUS_CATEGORIES,
  STANDARD_OBJECTS,
} from './catalogue.js';
export {
  FIELD_TYPES,
  SHARING_MODELS,
  type FieldType,
  type ObjectColor,
  type ReferenceTarget,
  type SharingModel,
  type StandardField,
  type StandardObject,
  type StandardObjectApiName,
} from './types.js';

const BY_NAME = new Map<string, StandardObject>(STANDARD_OBJECTS.map((o) => [o.apiName, o]));

export function isStandardObject(apiName: string): apiName is StandardObjectApiName {
  return BY_NAME.has(apiName);
}

/** The standard object, or undefined for anything else (custom objects live in P02 metadata). */
export function standardObject(apiName: string): StandardObject | undefined {
  return BY_NAME.get(apiName);
}

export function standardField(
  objectApiName: string,
  fieldApiName: string,
): StandardField | undefined {
  return BY_NAME.get(objectApiName)?.fields.find((f) => f.apiName === fieldApiName);
}

/**
 * Whether field-level security (§6.2 layer 5) can restrict the field. System fields are always
 * readable and never editable; required fields must stay editable so records can be saved.
 */
export function isFlsControllable(field: StandardField): boolean {
  return !field.system && !field.required;
}

/** The fields FLS applies to, in catalogue order. */
export function flsFields(objectApiName: string): StandardField[] {
  return (BY_NAME.get(objectApiName)?.fields ?? []).filter(isFlsControllable);
}

/** OWD defaults for a new tenant (§6.3). */
export function defaultSharing(): Record<StandardObjectApiName, SharingModel> {
  return Object.fromEntries(STANDARD_OBJECTS.map((o) => [o.apiName, o.sharing.default])) as Record<
    StandardObjectApiName,
    SharingModel
  >;
}
