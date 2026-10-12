import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';

import { Inject, Injectable } from '@nestjs/common';
import type {
  CreateInboundAddressRequest,
  InboundAddressDto,
  InboundEmailDetailDto,
  InboundEmailDto,
  UpdateInboundAddressRequest,
} from '@sm/contracts';
import { audit, outbox, withTenant, type CellPrisma, type TenantTransaction } from '@sm/db';
import { INBOUND_EMAIL_TOPIC } from '@sm/imports';
import {
  parseEmail,
  SecretInboundSource,
  SesSnsInboundSource,
  storageKey,
  type InboundEmailSource,
  type StorageProvider,
} from '@sm/integrations';
import { fieldAccess, objectAccess } from '@sm/permissions';
import { hasAccess, RecordError, type RecordContext } from '@sm/records';
import { DomainError, errors } from '@sm/server-kit';
import type { Logger } from 'pino';
import type { z } from 'zod';

import type { ApiConfig } from '../config.js';
import { isWritable, MetadataService } from '../metadata/metadata.service.js';
import { PermissionService } from '../permissions/permission.service.js';
import { assertVersion, isUniqueViolation } from '../setup/common.js';
import { CONFIG, LOGGER, PRISMA, STORAGE } from '../tokens.js';
import {
  inboundAddress,
  newInboundToken,
  tenantOfToken,
  tokenOfAddress,
} from './inbound-address.js';

type Address = z.infer<typeof InboundAddressDto>;
type Email = z.infer<typeof InboundEmailDto>;
type Input = z.output<typeof CreateInboundAddressRequest>;
type Problem = { field: string; code: string; message: string };

const INCLUDE = { runAs: { select: { id: true, name: true } } };

interface AddressRow {
  id: string;
  name: string;
  token: string;
  status: string;
  defaults: unknown;
  assignmentRuleId: string | null;
  version: number;
  runAs: { id: string; name: string };
}

interface EmailRow {
  id: string;
  receivedAt: Date;
  status: Email['status'];
  fromAddress: string;
  fromName: string | null;
  subject: string | null;
  recordObject: string | null;
  recordId: string | null;
  reason: string | null;
}

const emailDto = (r: EmailRow): Email => ({
  id: r.id,
  receivedAt: r.receivedAt.toISOString(),
  status: r.status,
  fromAddress: r.fromAddress,
  fromName: r.fromName,
  subject: r.subject,
  recordObject: r.recordObject,
  recordId: r.recordId,
  reason: r.reason,
});

async function bytes(stream: Readable, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const b = Buffer.from(chunk as Buffer);
    size += b.length;
    if (size > max) {
      stream.destroy();
      return null;
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

/**
 * Email-to-lead (§7.1, P03 T21). Setup manages per-tenant addresses; the inbound adapter delivers
 * mail here, where it is stored (raw, in object storage, with an `inbound_email` row) before the
 * worker turns it into a lead or files it on the sender's record.
 */
@Injectable()
export class InboundEmailService {
  private readonly sources: InboundEmailSource[];

  constructor(
    @Inject(PRISMA) private readonly prisma: CellPrisma,
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(STORAGE) private readonly storage: StorageProvider | null,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly metadata: MetadataService,
    private readonly permissions: PermissionService,
  ) {
    this.sources = [
      ...(config.INBOUND_SES_TOPIC_ARN
        ? [new SesSnsInboundSource(config.INBOUND_SES_TOPIC_ARN)]
        : []),
      ...(config.INBOUND_EMAIL_SECRET
        ? [new SecretInboundSource(config.INBOUND_EMAIL_SECRET)]
        : []),
    ];
  }

  private files(): StorageProvider {
    if (!this.storage)
      throw new DomainError('service_unavailable', 503, 'File storage is not configured');
    return this.storage;
  }

  // ── Setup → Email-to-lead ──────────────────────────────────────────────────

  private dto(r: AddressRow): Address {
    return {
      id: r.id,
      name: r.name,
      status: r.status as Address['status'],
      address: inboundAddress(r.token, this.config.INBOUND_EMAIL_DOMAIN),
      runAsUser: r.runAs,
      defaults: r.defaults as Address['defaults'],
      assignmentRuleId: r.assignmentRuleId,
      version: r.version,
    };
  }

  /** A run-as user who can create leads and set every default; a lead assignment rule. */
  private async check(tx: TenantTransaction, input: Input): Promise<void> {
    const problems: Problem[] = [];
    const runAs = await tx.prisma.user.findFirst({
      where: { id: input.runAsUserId, status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });
    if (!runAs)
      throw errors.validation([
        { field: 'runAsUserId', code: 'invalid_reference', message: 'No such active user' },
      ]);
    const perms = await this.permissions.forUser(tx, runAs.id);
    if (!objectAccess(perms, 'lead').create)
      problems.push({
        field: 'runAsUserId',
        code: 'cannot_create',
        message: 'This user cannot create leads',
      });
    const lead = (await this.metadata.forTenant(tx)).object('lead');
    for (const key of Object.keys(input.defaults)) {
      const f = lead?.fields.find((x) => x.apiName === key);
      if (!f || !isWritable(f) || !fieldAccess(perms, 'lead', key, f).edit)
        problems.push({
          field: `defaults.${key}`,
          code: 'not_editable',
          message: 'The run-as user cannot set this field',
        });
    }
    if (input.assignmentRuleId) {
      const rule = await tx.prisma.assignmentRule.findFirst({
        where: { id: input.assignmentRuleId, object: 'lead' },
      });
      if (!rule)
        problems.push({
          field: 'assignmentRuleId',
          code: 'invalid_reference',
          message: 'No such lead assignment rule',
        });
    }
    if (problems.length) throw errors.validation(problems);
  }

  async list(tx: TenantTransaction): Promise<Address[]> {
    return (
      await tx.prisma.inboundEmailAddress.findMany({ include: INCLUDE, orderBy: { name: 'asc' } })
    ).map((r) => this.dto(r));
  }

  async get(tx: TenantTransaction, id: string): Promise<Address> {
    const row = await tx.prisma.inboundEmailAddress.findFirst({ where: { id }, include: INCLUDE });
    if (!row) throw errors.notFound('Inbound address');
    return this.dto(row);
  }

  async create(tx: TenantTransaction, input: Input): Promise<Address> {
    await this.check(tx, input);
    const row = await tx.prisma.inboundEmailAddress.create({
      data: {
        tenantId: tx.context.tenantId,
        name: input.name,
        token: newInboundToken(tx.context.tenantId),
        status: input.status,
        runAsUserId: input.runAsUserId,
        defaults: input.defaults,
        assignmentRuleId: input.assignmentRuleId,
        createdBy: tx.context.userId ?? null,
      },
      include: INCLUDE,
    });
    const out = this.dto(row);
    await audit.setup(tx, {
      action: 'inbound_address.created',
      entityType: 'inbound_address',
      entityId: out.id,
      entityName: out.name,
      after: { ...out, version: undefined },
    });
    return out;
  }

  async update(
    tx: TenantTransaction,
    id: string,
    input: z.output<typeof UpdateInboundAddressRequest>,
  ): Promise<Address> {
    const current = await tx.prisma.inboundEmailAddress.findFirst({
      where: { id },
      include: INCLUDE,
    });
    assertVersion(current, input.version, 'Inbound address');
    const before = this.dto(current);
    const next: Input = {
      name: input.name ?? before.name,
      status: input.status ?? before.status,
      runAsUserId: input.runAsUserId ?? before.runAsUser.id,
      defaults: input.defaults ?? before.defaults,
      assignmentRuleId:
        input.assignmentRuleId === undefined ? before.assignmentRuleId : input.assignmentRuleId,
    };
    await this.check(tx, next);
    const row = await tx.prisma.inboundEmailAddress.update({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
      data: {
        name: next.name,
        status: next.status,
        runAsUserId: next.runAsUserId,
        defaults: next.defaults,
        assignmentRuleId: next.assignmentRuleId,
        ...(input.rotateAddress ? { token: newInboundToken(tx.context.tenantId) } : {}),
        version: { increment: 1 },
      },
      include: INCLUDE,
    });
    const out = this.dto(row);
    await audit.setup(tx, {
      action: input.rotateAddress ? 'inbound_address.rotated' : 'inbound_address.updated',
      entityType: 'inbound_address',
      entityId: id,
      entityName: out.name,
      before: { ...before, version: undefined },
      after: { ...out, version: undefined },
    });
    return out;
  }

  /** Deleting an address deletes the emails received at it (their leads stay). */
  async remove(tx: TenantTransaction, id: string): Promise<void> {
    const current = await tx.prisma.inboundEmailAddress.findFirst({
      where: { id },
      include: INCLUDE,
    });
    if (!current) throw errors.notFound('Inbound address');
    await tx.prisma.inboundEmailAddress.delete({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
    });
    await audit.setup(tx, {
      action: 'inbound_address.deleted',
      entityType: 'inbound_address',
      entityId: id,
      entityName: current.name,
      before: { ...this.dto(current), version: undefined },
    });
  }

  async emails(
    tx: TenantTransaction,
    id: string,
    q: { status?: Email['status'] | undefined; before?: string | undefined; limit: number },
  ): Promise<{ items: Email[]; next: string | null }> {
    if (!(await tx.prisma.inboundEmailAddress.findFirst({ where: { id }, select: { id: true } })))
      throw errors.notFound('Inbound address');
    const rows = await tx.prisma.inboundEmail.findMany({
      where: {
        addressId: id,
        ...(q.status ? { status: q.status } : {}),
        ...(q.before ? { id: { lt: q.before } } : {}),
      },
      orderBy: { id: 'desc' },
      take: q.limit + 1,
    });
    const page = rows.slice(0, q.limit);
    return {
      items: page.map(emailDto),
      next: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  // ── Delivery ───────────────────────────────────────────────────────────────

  /**
   * Mail from the inbound adapter. Each recipient that is an ACTIVE address of a workspace in
   * this cell gets its own copy of the raw message and an `inbound_email` row (once per Message-ID),
   * and the worker is asked to process it. Unknown recipients are dropped silently.
   */
  async receive(
    headers: Record<string, string | undefined>,
    body: unknown,
  ): Promise<{ accepted: number }> {
    let result = null;
    for (const source of this.sources) {
      result = await source.accept(headers, body);
      if (result) break;
    }
    if (!result) throw errors.unauthenticated('Not from a configured inbound source');
    if (result.kind === 'ignored') return { accepted: 0 };
    const storage = this.files();
    const { delivery } = result;
    const max = this.config.INBOUND_EMAIL_MAX_BYTES;
    const raw =
      delivery.raw ??
      (delivery.storageKey ? await bytes(await storage.getObject(delivery.storageKey), max) : null);
    if (!raw?.length || raw.length > max) {
      this.logger.warn({ size: raw?.length ?? null }, 'inbound email dropped: empty or too large');
      return { accepted: 0 };
    }
    const parsed = await parseEmail(raw, 0);
    const tokens = new Set(
      delivery.recipients
        .map((r) => tokenOfAddress(r, this.config.INBOUND_EMAIL_DOMAIN))
        .filter((t): t is string => t !== null),
    );
    let accepted = 0;
    for (const token of tokens) {
      const tenantId = tenantOfToken(token);
      if (!tenantId) continue;
      try {
        const stored = await withTenant(this.prisma, { tenantId }, async (tx) => {
          const address = await tx.prisma.inboundEmailAddress.findFirst({
            where: { token, status: 'ACTIVE' },
            select: { id: true },
          });
          if (!address) return false;
          if (
            parsed.messageId &&
            (await tx.prisma.inboundEmail.findFirst({
              where: { messageId: parsed.messageId },
              select: { id: true },
            }))
          )
            return false;
          const rawKey = storageKey(tenantId, randomUUID());
          await storage.putObject(rawKey, raw, 'message/rfc822');
          const row = await tx.prisma.inboundEmail.create({
            data: {
              tenantId,
              addressId: address.id,
              messageId: parsed.messageId,
              fromAddress: parsed.from?.address ?? '',
              fromName: parsed.from?.name?.slice(0, 255) ?? null,
              subject: parsed.subject,
              rawKey,
            },
            select: { id: true },
          });
          await outbox.emit(tx, {
            topic: INBOUND_EMAIL_TOPIC,
            aggregateType: 'inbound_email',
            aggregateId: row.id,
            payload: { emailId: row.id },
          });
          return true;
        });
        if (stored) accepted += 1;
      } catch (err) {
        // The same message delivered twice at once: the first one wins.
        if (!isUniqueViolation(err)) throw err;
      }
    }
    return { accepted };
  }

  // ── On records ─────────────────────────────────────────────────────────────

  /** Emails stored on a lead or contact the caller can see, when they can read its email field. */
  private async visible(
    tx: TenantTransaction,
    ctx: RecordContext,
    objectName: string,
    id: string,
  ): Promise<boolean> {
    const object = ctx.metadata.object(objectName);
    if (
      !object ||
      !objectAccess(ctx.permissions, objectName).read ||
      !(await hasAccess(tx, ctx, object, id, 'read'))
    )
      throw new RecordError('not_found');
    const email = object.fields.find((f) => f.apiName === 'email');
    return !!email && fieldAccess(ctx.permissions, objectName, 'email', email).read;
  }

  async forRecord(
    tx: TenantTransaction,
    ctx: RecordContext,
    objectName: string,
    id: string,
  ): Promise<{ items: Email[] }> {
    if (!(await this.visible(tx, ctx, objectName, id))) return { items: [] };
    const rows = await tx.prisma.inboundEmail.findMany({
      where: { recordObject: objectName, recordId: id },
      orderBy: { receivedAt: 'desc' },
      take: 50,
    });
    return { items: rows.map(emailDto) };
  }

  async oneForRecord(
    tx: TenantTransaction,
    ctx: RecordContext,
    objectName: string,
    id: string,
    emailId: string,
  ): Promise<z.infer<typeof InboundEmailDetailDto>> {
    const row = (await this.visible(tx, ctx, objectName, id))
      ? await tx.prisma.inboundEmail.findFirst({
          where: { id: emailId, recordObject: objectName, recordId: id },
        })
      : null;
    if (!row) throw new RecordError('not_found');
    const raw = await bytes(
      await this.files().getObject(row.rawKey),
      this.config.INBOUND_EMAIL_MAX_BYTES,
    );
    const parsed = raw ? await parseEmail(raw) : null;
    return { ...emailDto(row), text: parsed?.text ?? '' };
  }
}
