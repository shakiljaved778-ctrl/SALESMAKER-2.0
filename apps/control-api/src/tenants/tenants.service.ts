import { Inject, Injectable } from '@nestjs/common';
import { DomainError, emailRoutingHmac, errors } from '@sm/server-kit';
import { uuidv7 } from 'uuidv7';

import type { ControlApiConfig } from '../config.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { ControlPlanePrisma } from '../prisma.js';
import { CONFIG, PRISMA } from '../tokens.js';
import { isReservedSlug } from './slug-policy.js';

export interface ReservedTenantDto {
  tenantId: string;
  slug: string;
  status: 'PENDING' | 'ACTIVE' | 'SUSPENDED';
  cellId: string;
  [key: string]: string;
}

const slugTaken = () => new DomainError('conflict', 409, 'That workspace address is taken');

@Injectable()
export class TenantsService {
  constructor(
    @Inject(CONFIG) private readonly config: ControlApiConfig,
    @Inject(PRISMA) private readonly prisma: ControlPlanePrisma,
  ) {}

  /** Host → tenant. Unknown hosts and lapsed reservations are simply not found. */
  async resolveHost(host: string) {
    const normalised = host.trim().toLowerCase();
    const suffix = `.${this.config.WEB_BASE_DOMAIN.toLowerCase()}`;
    const tenant = normalised.endsWith(suffix)
      ? await this.prisma.tenant.findUnique({
          where: { slug: normalised.slice(0, -suffix.length) },
          include: { cell: true },
        })
      : (
          await this.prisma.tenantDomain.findUnique({
            where: { host: normalised },
            include: { tenant: { include: { cell: true } } },
          })
        )?.tenant;
    if (!tenant || this.lapsed(tenant)) throw errors.notFound('Workspace');
    return {
      tenantId: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      status: tenant.status,
      cell: { id: tenant.cell.id, apiBaseUrl: tenant.cell.apiBaseUrl },
    };
  }

  /** Signup step 1: hold a slug for the calling cell. Runs inside the idempotency transaction. */
  async reserve(
    tx: Prisma.TransactionClient,
    cellId: string,
    input: { slug: string; name: string; ownerEmailHmac: string },
  ): Promise<ReservedTenantDto> {
    const cell = await tx.cell.findUnique({ where: { id: cellId } });
    if (!cell) throw errors.notFound('Cell');
    if (!cell.signupOpen) throw errors.forbidden('This region is not accepting new organisations');
    if (isReservedSlug(input.slug)) throw slugTaken();

    const existing = await tx.tenant.findUnique({ where: { slug: input.slug } });
    if (existing) {
      if (!this.lapsed(existing)) throw slugTaken();
      await tx.tenant.delete({ where: { id: existing.id } });
    }
    const tenant = await tx.tenant.create({
      data: {
        id: uuidv7(),
        slug: input.slug,
        name: input.name,
        cellId,
        status: 'PENDING',
        ownerEmailHmac: new Uint8Array(Buffer.from(input.ownerEmailHmac, 'base64url')),
        reservedUntil: new Date(Date.now() + this.config.PENDING_RESERVATION_HOURS * 3600 * 1000),
      },
    });
    return { tenantId: tenant.id, slug: tenant.slug, status: tenant.status, cellId };
  }

  /** Signup step 2 (idempotent): the owner verified their email, so the tenant goes live. */
  async activate(cellId: string, tenantId: string): Promise<ReservedTenantDto> {
    return this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
      // Another cell's tenant is "not found" to the caller (§3.5: never leak existence).
      if (!tenant || tenant.cellId !== cellId || this.lapsed(tenant))
        throw errors.notFound('Tenant');
      if (tenant.status === 'SUSPENDED') throw errors.conflict('The tenant is suspended');
      if (tenant.status === 'PENDING') {
        await tx.tenant.update({
          where: { id: tenantId },
          data: {
            status: 'ACTIVE',
            activatedAt: new Date(),
            reservedUntil: null,
            ownerEmailHmac: null,
          },
        });
        if (tenant.ownerEmailHmac) {
          await tx.userRouting.upsert({
            where: { emailHmac_tenantId: { emailHmac: tenant.ownerEmailHmac, tenantId } },
            create: { emailHmac: tenant.ownerEmailHmac, tenantId },
            update: {},
          });
        }
      }
      return { tenantId, slug: tenant.slug, status: 'ACTIVE' as const, cellId };
    });
  }

  /** Signup compensation: drop a PENDING reservation. Releasing twice is fine. */
  async release(cellId: string, tenantId: string): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) return;
    if (tenant.cellId !== cellId) throw errors.notFound('Tenant');
    if (tenant.status !== 'PENDING')
      throw errors.conflict('Only a pending reservation can be released');
    await this.prisma.tenant.delete({ where: { id: tenantId } });
  }

  /** Active workspaces an email belongs to, for the "find my workspaces" email. */
  async workspacesFor(email: string): Promise<{ name: string; url: string }[]> {
    const emailHmac = new Uint8Array(emailRoutingHmac(email, this.config.EMAIL_ROUTING_PEPPER));
    const routings = await this.prisma.userRouting.findMany({
      where: { emailHmac, tenant: { status: 'ACTIVE' } },
      include: { tenant: true },
      orderBy: { tenant: { name: 'asc' } },
    });
    return routings.map(({ tenant }) => ({
      name: tenant.name,
      url: `${this.config.WEB_URL_SCHEME}://${tenant.slug}.${this.config.WEB_BASE_DOMAIN}`,
    }));
  }

  private lapsed(tenant: { status: string; reservedUntil: Date | null }): boolean {
    return (
      tenant.status === 'PENDING' &&
      tenant.reservedUntil !== null &&
      tenant.reservedUntil <= new Date()
    );
  }
}
