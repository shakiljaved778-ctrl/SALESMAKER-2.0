import { Inject, Injectable } from '@nestjs/common';
import { loadTenantMetadata, type TenantTransaction } from '@sm/db';
import { serverTranslator } from '@sm/i18n';
import {
  CATALOGUE_VERSION,
  isSortable,
  MetadataCache,
  READ_ONLY_TYPES,
  type FieldMeta,
  type FieldType,
  type MetadataIndex,
} from '@sm/metadata';
import { fieldAccess, objectAccess, type EffectivePermissions } from '@sm/permissions';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { LOGGER, REDIS } from '../tokens.js';
import { syncStandardMetadata } from './standard-metadata.js';

type Translate = (key: string) => string;

export interface DescribedField {
  name: string;
  label: string;
  type: FieldType;
  custom: boolean;
  required: boolean;
  /** Visible to this user under FLS. Hidden fields are not listed at all. */
  readable: true;
  /** Writable by this user: FLS, object access and the field's type all allow it. */
  editable: boolean;
  sortable: boolean;
  searchable: boolean;
  unique: boolean;
  externalId: boolean;
  length: number | null;
  precision: number | null;
  scale: number | null;
  referenceTo: string[];
  helpText: string | null;
  picklistValues?: { value: string; label: string; category: string | null; default: boolean }[];
}

export interface DescribedObject {
  name: string;
  label: string;
  labelPlural: string;
  custom: boolean;
  icon: string;
  color: string;
  nameFields: readonly string[];
  access: { read: boolean; create: boolean; edit: boolean; delete: boolean };
  recordTypes: { id: string; name: string; apiName: string; default: boolean }[];
  fields: DescribedField[];
}

/**
 * The tenant's metadata (§5), cached under `metadataVersion` (§3.10) in process and in Valkey.
 * A tenant behind the catalogue is synced first (P02 T01), inside the caller's transaction.
 */
@Injectable()
export class MetadataService {
  private readonly cache: MetadataCache;

  constructor(@Inject(REDIS) redis: Redis, @Inject(LOGGER) logger: Logger) {
    this.cache = new MetadataCache(redis, {
      onError: (err) => {
        logger.warn({ err }, 'metadata cache unavailable; loading directly');
      },
    });
  }

  async forTenant(tx: TenantTransaction): Promise<MetadataIndex> {
    const { tenantId } = tx.context;
    const read = () =>
      tx.prisma.tenantSettings.findUniqueOrThrow({
        where: { tenantId },
        select: { metadataVersion: true, catalogueVersion: true },
      });
    let settings = await read();
    if (settings.catalogueVersion < CATALOGUE_VERSION) {
      await syncStandardMetadata(tx);
      settings = await read();
    }
    const version = settings.metadataVersion;
    return this.cache.getOrLoad(tenantId, version, () => loadTenantMetadata(tx, version));
  }

  /**
   * Describe an object for a user (§10.1 `describe`): the fields they can read under FLS, with
   * what they may edit, labels in their locale and the record types they can pick. Null when the
   * object does not exist or they cannot read it (the API answers 404 for both).
   */
  describe(
    metadata: MetadataIndex,
    objectName: string,
    permissions: EffectivePermissions,
    locale: string,
  ): DescribedObject | null {
    const object = metadata.object(objectName);
    if (!object) return null;
    const access = objectAccess(permissions, objectName);
    if (!access.read) return null;
    const t = serverTranslator(locale) as unknown as Translate;
    const label = (own: string | null, key: string | null, fallback: string) =>
      own ?? (key ? t(key) : fallback);
    const fields = object.fields.flatMap((f): DescribedField[] => {
      const fls = fieldAccess(permissions, objectName, f.apiName, f);
      if (!fls.read) return [];
      return [
        {
          name: f.apiName,
          label: label(f.label, f.labelKey, f.apiName),
          type: f.type,
          custom: !f.isStandard,
          required: f.required,
          readable: true,
          editable: fls.edit && isWritable(f),
          sortable: isSortable(f.type),
          searchable: f.searchable,
          unique: f.unique,
          externalId: f.externalId,
          length: f.length,
          precision: f.precision,
          scale: f.scale,
          referenceTo: f.referenceTo,
          helpText: f.helpText,
          ...(f.type === 'picklist' || f.type === 'multi_picklist'
            ? {
                picklistValues: f.picklistValues
                  .filter((v) => v.active)
                  .map((v) => ({
                    value: v.apiValue,
                    label: label(v.label, v.labelKey, v.apiValue),
                    category: v.category,
                    default: v.isDefault,
                  })),
              }
            : {}),
        },
      ];
    });
    return {
      name: object.apiName,
      label: label(object.label.singular, object.labelKey?.singular ?? null, object.apiName),
      labelPlural: label(object.label.plural, object.labelKey?.plural ?? null, object.apiName),
      custom: !object.isStandard,
      icon: object.icon,
      color: object.color,
      nameFields: metadata.nameFields(objectName),
      access: {
        read: access.read,
        create: access.create,
        edit: access.edit,
        delete: access.delete,
      },
      recordTypes: object.recordTypes
        .filter((r) => r.active)
        .map((r) => ({ id: r.id, name: r.name, apiName: r.apiName, default: r.isDefault })),
      fields,
    };
  }
}

/** Whether a user could ever write the field: not computed and not platform-maintained. */
export function isWritable(field: FieldMeta): boolean {
  return !field.system && !READ_ONLY_TYPES.has(field.type);
}
