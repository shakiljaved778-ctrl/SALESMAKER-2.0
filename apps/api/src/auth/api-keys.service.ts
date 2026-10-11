import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { ApiKeyDto, CreateApiKeyRequest, RotateApiKeyRequest } from '@sm/contracts';
import { audit, withTenant, type CellPrisma, type TenantTransaction } from '@sm/db';
import { hasSystemPermission } from '@sm/permissions';
import { errors } from '@sm/server-kit';
import { uuidv7 } from 'uuidv7';
import type { z } from 'zod';

import { AccessService } from '../access/access.service.js';
import { PRISMA } from '../tokens.js';

type ApiKey = z.infer<typeof ApiKeyDto>;
type Environment = 'LIVE' | 'TEST';

const PREFIX: Record<Environment, string> = { LIVE: 'sm_live_', TEST: 'sm_test_' };
const SECRET_BYTES = 32;
/** last_used_at is written at most this often per key, not on every call. */
const LAST_USED_RESOLUTION_MS = 60_000;

const uuidBytes = (id: string) => Buffer.from(id.replaceAll('-', ''), 'hex');
const uuidOf = (bytes: Buffer) =>
  bytes.toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

/**
 * An API key is `sm_live_` (or `sm_test_`) followed by base64url(tenant id ‖ key id ‖ secret):
 * the tenant and the key are known before anything is read, so a key opens its own tenant's
 * transaction and finds its row by primary key with no cross-tenant lookup. Only the secret's
 * SHA-256 is stored (a 256-bit random secret needs no slow hash).
 */
export function encodeApiKey(
  environment: Environment,
  tenantId: string,
  keyId: string,
  secret: Buffer,
): string {
  const body = Buffer.concat([uuidBytes(tenantId), uuidBytes(keyId), secret]);
  return `${PREFIX[environment]}${body.toString('base64url')}`;
}

export interface ParsedApiKey {
  environment: Environment;
  tenantId: string;
  keyId: string;
  secret: Buffer;
}

export function parseApiKey(token: string): ParsedApiKey | null {
  const environment = (Object.keys(PREFIX) as Environment[]).find((e) =>
    token.startsWith(PREFIX[e]),
  );
  if (!environment) return null;
  const encoded = token.slice(PREFIX[environment].length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const body = Buffer.from(encoded, 'base64url');
  if (body.length !== 32 + SECRET_BYTES || body.toString('base64url') !== encoded) return null;
  return {
    environment,
    tenantId: uuidOf(body.subarray(0, 16)),
    keyId: uuidOf(body.subarray(16, 32)),
    secret: body.subarray(32),
  };
}

export const isApiKey = (token: string) =>
  token.startsWith(PREFIX.LIVE) || token.startsWith(PREFIX.TEST);

const hashSecret = (secret: Buffer) => createHash('sha256').update(secret).digest('hex');

export interface ApiKeyCaller {
  tenantId: string;
  userId: string;
  apiKeyId: string;
}

interface KeyRow {
  id: string;
  name: string;
  environment: Environment;
  hint: string;
  runAsUserId: string;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  rotatedFromId: string | null;
  createdAt: Date;
  runAs: { name: string };
}

const KEY_SELECT = {
  id: true,
  name: true,
  environment: true,
  hint: true,
  runAsUserId: true,
  expiresAt: true,
  lastUsedAt: true,
  revokedAt: true,
  rotatedFromId: true,
  createdAt: true,
  runAs: { select: { name: true } },
} as const;

function statusOf(row: Pick<KeyRow, 'expiresAt' | 'revokedAt'>, now = new Date()) {
  if (row.revokedAt && row.revokedAt <= now) return 'revoked' as const;
  if (row.expiresAt && row.expiresAt <= now) return 'expired' as const;
  return 'active' as const;
}

function toDto(row: KeyRow): ApiKey {
  return {
    id: row.id,
    name: row.name,
    environment: row.environment,
    preview: `${PREFIX[row.environment]}…${row.hint}`,
    runAsUser: { id: row.runAsUserId, name: row.runAs.name },
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    rotatedFromId: row.rotatedFromId,
    status: statusOf(row),
    createdAt: row.createdAt.toISOString(),
  };
}

const invalidKey = () => errors.unauthenticated('The API key is not valid');

/**
 * API keys (§6, §10.1): issued for a run-as user, stored hashed, with expiry, last-used tracking,
 * rotation and revocation. Calls made with a key run as that user, with that user's permissions.
 */
@Injectable()
export class ApiKeysService {
  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    private readonly access: AccessService,
  ) {}

  async list(tx: TenantTransaction): Promise<ApiKey[]> {
    const rows = await tx.prisma.apiKey.findMany({
      select: KEY_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(toDto);
  }

  async create(
    tx: TenantTransaction,
    input: z.output<typeof CreateApiKeyRequest>,
  ): Promise<{ key: ApiKey; secret: string }> {
    await this.requireRunAsUser(tx, input.runAsUserId);
    const expiresAt = this.futureExpiry(input.expiresAt);
    const issued = await this.issue(tx, {
      name: input.name,
      environment: input.environment,
      runAsUserId: input.runAsUserId,
      expiresAt,
      rotatedFromId: null,
    });
    await audit.setup(tx, {
      action: 'api_key.created',
      entityType: 'api_key',
      entityId: issued.key.id,
      entityName: issued.key.name,
      after: this.auditView(issued.key),
    });
    return issued;
  }

  async rotate(
    tx: TenantTransaction,
    id: string,
    input: z.output<typeof RotateApiKeyRequest>,
  ): Promise<{ key: ApiKey; secret: string }> {
    const old = await tx.prisma.apiKey.findUnique({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
      select: KEY_SELECT,
    });
    if (!old) throw errors.notFound('API key');
    if (statusOf(old) !== 'active') throw errors.conflict('Only an active key can be rotated');
    await this.requireRunAsUser(tx, old.runAsUserId);
    const expiresAt =
      input.expiresAt === undefined ? old.expiresAt : this.futureExpiry(input.expiresAt);
    const issued = await this.issue(tx, {
      name: old.name,
      environment: old.environment,
      runAsUserId: old.runAsUserId,
      expiresAt,
      rotatedFromId: old.id,
    });
    // The old key keeps working for the grace period so integrations can switch over.
    const cutoff = new Date(Date.now() + input.graceMinutes * 60_000);
    await tx.prisma.apiKey.update({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
      data: { revokedAt: cutoff, version: { increment: 1 } },
    });
    await audit.setup(tx, {
      action: 'api_key.rotated',
      entityType: 'api_key',
      entityId: issued.key.id,
      entityName: issued.key.name,
      before: { id: old.id, preview: toDto(old).preview },
      after: { ...this.auditView(issued.key), oldKeyRevokedAt: cutoff.toISOString() },
    });
    return issued;
  }

  async revoke(tx: TenantTransaction, id: string): Promise<void> {
    const key = await tx.prisma.apiKey.findUnique({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
      select: KEY_SELECT,
    });
    if (!key) throw errors.notFound('API key');
    if (key.revokedAt && key.revokedAt <= new Date()) return;
    await tx.prisma.apiKey.update({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
      data: { revokedAt: new Date(), version: { increment: 1 } },
    });
    await audit.setup(tx, {
      action: 'api_key.revoked',
      entityType: 'api_key',
      entityId: id,
      entityName: key.name,
      before: this.auditView(toDto(key)),
    });
  }

  /**
   * Verify a presented key: well formed, known in its own tenant, secret matching, not revoked or
   * expired, and its run-as user active and API enabled. Any failure is the same 401, so a key's
   * existence is never revealed.
   */
  async authenticate(token: string): Promise<ApiKeyCaller> {
    const parsed = parseApiKey(token);
    if (!parsed) throw invalidKey();
    const { tenantId, keyId } = parsed;
    return withTenant(this.prisma, { tenantId }, async (tx) => {
      const key = await tx.prisma.apiKey.findUnique({
        where: { tenantId_id: { tenantId, id: keyId } },
        select: {
          secretHash: true,
          environment: true,
          runAsUserId: true,
          expiresAt: true,
          revokedAt: true,
          lastUsedAt: true,
          runAs: { select: { status: true, deletedAt: true } },
        },
      });
      const presented = Buffer.from(hashSecret(parsed.secret), 'hex');
      const stored = Buffer.from(key?.secretHash ?? '', 'hex');
      const matches = stored.length === presented.length && timingSafeEqual(stored, presented);
      if (!key || !matches || key.environment !== parsed.environment) throw invalidKey();
      const now = new Date();
      if (statusOf(key, now) !== 'active') throw invalidKey();
      if (key.runAs.status !== 'ACTIVE' || key.runAs.deletedAt) throw invalidKey();
      const permissions = await this.access.permissionsOf(tx, key.runAsUserId);
      if (!hasSystemPermission(permissions, 'api_enabled'))
        throw errors.forbidden('The API key’s user is not allowed to use the API');
      if (!key.lastUsedAt || now.getTime() - key.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS)
        await tx.prisma.apiKey.update({
          where: { tenantId_id: { tenantId, id: keyId } },
          data: { lastUsedAt: now },
        });
      return { tenantId, userId: key.runAsUserId, apiKeyId: keyId };
    });
  }

  private async issue(
    tx: TenantTransaction,
    input: {
      name: string;
      environment: Environment;
      runAsUserId: string;
      expiresAt: Date | null;
      rotatedFromId: string | null;
    },
  ): Promise<{ key: ApiKey; secret: string }> {
    const id = uuidv7();
    const secret = randomBytes(SECRET_BYTES);
    const token = encodeApiKey(input.environment, tx.context.tenantId, id, secret);
    const row = await tx.prisma.apiKey.create({
      data: {
        tenantId: tx.context.tenantId,
        id,
        name: input.name,
        environment: input.environment,
        secretHash: hashSecret(secret),
        hint: token.slice(-4),
        runAsUserId: input.runAsUserId,
        expiresAt: input.expiresAt,
        rotatedFromId: input.rotatedFromId,
        createdBy: tx.context.userId ?? null,
      },
      select: KEY_SELECT,
    });
    return { key: toDto(row), secret: token };
  }

  private async requireRunAsUser(tx: TenantTransaction, userId: string): Promise<void> {
    const user = await tx.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { status: true },
    });
    if (!user)
      throw errors.validation([
        { field: 'runAsUserId', code: 'not_found', message: 'No such user' },
      ]);
    if (user.status !== 'ACTIVE')
      throw errors.validation([
        { field: 'runAsUserId', code: 'inactive', message: 'The user must be active' },
      ]);
    if (!hasSystemPermission(await this.access.permissionsOf(tx, userId), 'api_enabled'))
      throw errors.validation([
        {
          field: 'runAsUserId',
          code: 'not_api_enabled',
          message: 'The user needs the "API enabled" permission',
        },
      ]);
  }

  private futureExpiry(value: string | null | undefined): Date | null {
    if (value === null || value === undefined) return null;
    const at = new Date(value);
    if (at.getTime() <= Date.now())
      throw errors.validation([
        { field: 'expiresAt', code: 'in_past', message: 'The expiry must be in the future' },
      ]);
    return at;
  }

  private auditView(key: ApiKey) {
    return {
      name: key.name,
      environment: key.environment,
      preview: key.preview,
      runAsUserId: key.runAsUser.id,
      expiresAt: key.expiresAt,
    };
  }
}
