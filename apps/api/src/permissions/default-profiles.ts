import type { TenantTransaction } from '@sm/db';
import { serverTranslator } from '@sm/i18n';
import { DEFAULT_PROFILES, type DefaultProfileKey, type Grants } from '@sm/permissions';

/** Write one grant bundle into a permission set (system, object and field rows). */
export async function writeGrants(
  tx: TenantTransaction,
  tenantId: string,
  permissionSetId: string,
  grants: Grants,
): Promise<void> {
  const { prisma } = tx;
  if (grants.system.length)
    await prisma.systemPermission.createMany({
      data: grants.system.map((name) => ({ tenantId, permissionSetId, name })),
    });
  const objects = Object.entries(grants.objects).flatMap(([object, a]) =>
    a
      ? [
          {
            tenantId,
            permissionSetId,
            object,
            canRead: a.read,
            canCreate: a.create,
            canEdit: a.edit,
            canDelete: a.delete,
            viewAll: a.viewAll,
            modifyAll: a.modifyAll,
          },
        ]
      : [],
  );
  if (objects.length) await prisma.objectPermission.createMany({ data: objects });
  const fields = Object.entries(grants.fields).flatMap(([object, byField]) =>
    Object.entries(byField ?? {}).flatMap(([field, a]) =>
      a ? [{ tenantId, permissionSetId, object, field, canRead: a.read, canEdit: a.edit }] : [],
    ),
  );
  if (fields.length) await prisma.fieldPermission.createMany({ data: fields });
}

/**
 * Create the built-in profiles of a new organisation (System Administrator, Standard User, Read
 * Only), named in its default locale. Runs inside the signup transaction.
 */
export async function provisionDefaultProfiles(
  tx: TenantTransaction,
  tenantId: string,
  locale: string,
): Promise<Record<DefaultProfileKey, string>> {
  const t = serverTranslator(locale) as unknown as (key: string) => string;
  const ids = {} as Record<DefaultProfileKey, string>;
  for (const def of DEFAULT_PROFILES) {
    const name = t(def.nameKey);
    const set = await tx.prisma.permissionSet.create({
      data: { tenantId, kind: 'PROFILE', name },
    });
    await writeGrants(tx, tenantId, set.id, def.grants);
    const profile = await tx.prisma.profile.create({
      data: {
        tenantId,
        name,
        description: t(def.descriptionKey),
        systemKey: def.key,
        permissionSetId: set.id,
      },
    });
    ids[def.key] = profile.id;
  }
  return ids;
}
