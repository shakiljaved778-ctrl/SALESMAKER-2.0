import { Injectable } from '@nestjs/common';
import type {
  BusinessHoursDto,
  CreateBusinessHoursRequest,
  PutUserRoutingRequest,
  UpdateBusinessHoursRequest,
  UserRoutingDto,
} from '@sm/contracts';
import { audit, type TenantTransaction } from '@sm/db';
import { hoursErrors, isValidTimezone, type WeeklyHours } from '@sm/records';
import { errors } from '@sm/server-kit';
import type { z } from 'zod';

import { assertVersion, isUniqueViolation, nameTaken } from './common.js';

type BusinessHours = z.infer<typeof BusinessHoursDto>;
type UserRouting = z.infer<typeof UserRoutingDto>;
type HolidayInput = { date: string; name: string; recurring: boolean };

const INCLUDE = { holidays: { orderBy: { date: 'asc' as const } } } as const;

interface Row {
  id: string;
  name: string;
  timezone: string;
  hours: unknown;
  isDefault: boolean;
  active: boolean;
  version: number;
  holidays: { date: Date; name: string; recurring: boolean }[];
}

const dto = (r: Row): BusinessHours => ({
  id: r.id,
  name: r.name,
  timezone: r.timezone,
  hours: r.hours as BusinessHours['hours'],
  isDefault: r.isDefault,
  active: r.active,
  holidays: r.holidays.map((h) => ({
    date: h.date.toISOString().slice(0, 10),
    name: h.name,
    recurring: h.recurring,
  })),
  version: r.version,
});

const auditView = (b: BusinessHours) =>
  JSON.parse(JSON.stringify({ ...b, version: undefined })) as Record<string, never>;

/** Weekly hours as stored JSON. */
const asJson = (hours: WeeklyHours) => hours as Record<string, string[][]>;

function checkHours(field: string, hours: WeeklyHours) {
  const problems = hoursErrors(hours);
  if (problems.length)
    throw errors.validation(
      problems.map((p) => ({
        field: `${field}.${p.field}`,
        code: p.code,
        message: p.code.replaceAll('_', ' '),
      })),
    );
}

function checkTimezone(timezone: string) {
  if (!isValidTimezone(timezone))
    throw errors.validation([
      { field: 'timezone', code: 'invalid', message: 'Not a known time zone' },
    ]);
}

function checkHolidays(holidays: readonly HolidayInput[]) {
  const dates = holidays.map((h) => h.date);
  if (new Set(dates).size !== dates.length)
    throw errors.validation([
      { field: 'holidays', code: 'duplicate_date', message: 'Each date once' },
    ]);
}

/** Setup → Business hours (§7.3) and users' routing settings (availability, skills, capacity). */
@Injectable()
export class RoutingSetupService {
  async list(tx: TenantTransaction): Promise<BusinessHours[]> {
    const rows = await tx.prisma.businessHours.findMany({
      include: INCLUDE,
      orderBy: { name: 'asc' },
    });
    return rows.map(dto);
  }

  async get(tx: TenantTransaction, id: string): Promise<BusinessHours> {
    const row = await tx.prisma.businessHours.findFirst({ where: { id }, include: INCLUDE });
    if (!row) throw errors.notFound('Business hours');
    return dto(row);
  }

  private async clearDefault(tx: TenantTransaction, except: string | null) {
    await tx.prisma.businessHours.updateMany({
      where: { isDefault: true, ...(except ? { id: { not: except } } : {}) },
      data: { isDefault: false, version: { increment: 1 } },
    });
  }

  async create(
    tx: TenantTransaction,
    input: z.output<typeof CreateBusinessHoursRequest>,
  ): Promise<BusinessHours> {
    checkTimezone(input.timezone);
    checkHours('hours', input.hours);
    checkHolidays(input.holidays);
    if (input.isDefault) await this.clearDefault(tx, null);
    try {
      const created = await tx.prisma.businessHours.create({
        data: {
          tenantId: tx.context.tenantId,
          name: input.name,
          timezone: input.timezone,
          hours: asJson(input.hours),
          isDefault: input.isDefault,
          active: input.active,
          createdBy: tx.context.userId ?? null,
        },
      });
      await tx.prisma.holiday.createMany({
        data: input.holidays.map((h) => ({
          tenantId: tx.context.tenantId,
          businessHoursId: created.id,
          date: new Date(`${h.date}T00:00:00Z`),
          name: h.name,
          recurring: h.recurring,
        })),
      });
      const row = await tx.prisma.businessHours.findFirstOrThrow({
        where: { id: created.id },
        include: INCLUDE,
      });
      const out = dto(row);
      await audit.setup(tx, {
        action: 'business_hours.created',
        entityType: 'business_hours',
        entityId: out.id,
        entityName: out.name,
        after: auditView(out),
      });
      return out;
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
  }

  async update(
    tx: TenantTransaction,
    id: string,
    input: z.output<typeof UpdateBusinessHoursRequest>,
  ): Promise<BusinessHours> {
    const current = await tx.prisma.businessHours.findFirst({ where: { id }, include: INCLUDE });
    assertVersion(current, input.version, 'Business hours');
    if (input.timezone) checkTimezone(input.timezone);
    if (input.hours) checkHours('hours', input.hours);
    if (input.holidays) checkHolidays(input.holidays);
    if (input.isDefault) await this.clearDefault(tx, id);
    if (input.holidays) {
      await tx.prisma.holiday.deleteMany({ where: { businessHoursId: id } });
      await tx.prisma.holiday.createMany({
        data: input.holidays.map((h) => ({
          tenantId: tx.context.tenantId,
          businessHoursId: id,
          date: new Date(`${h.date}T00:00:00Z`),
          name: h.name,
          recurring: h.recurring,
        })),
      });
    }
    try {
      const row = await tx.prisma.businessHours.update({
        where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
          ...(input.hours === undefined ? {} : { hours: asJson(input.hours) }),
          ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
          ...(input.active === undefined ? {} : { active: input.active }),
          version: { increment: 1 },
        },
        include: INCLUDE,
      });
      const out = dto(row);
      await audit.setup(tx, {
        action: 'business_hours.updated',
        entityType: 'business_hours',
        entityId: id,
        entityName: out.name,
        before: auditView(dto(current)),
        after: auditView(out),
      });
      return out;
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
  }

  async remove(tx: TenantTransaction, id: string): Promise<void> {
    const current = await tx.prisma.businessHours.findFirst({ where: { id }, include: INCLUDE });
    if (!current) throw errors.notFound('Business hours');
    const used = await tx.prisma.slaPolicy.count({ where: { businessHoursId: id } });
    if (used) throw errors.conflict('SLA policies use these business hours; change them first');
    await tx.prisma.businessHours.delete({
      where: { tenantId_id: { tenantId: tx.context.tenantId, id } },
    });
    await audit.setup(tx, {
      action: 'business_hours.deleted',
      entityType: 'business_hours',
      entityId: id,
      entityName: current.name,
      before: auditView(dto(current)),
    });
  }

  async userRouting(tx: TenantTransaction, userId: string): Promise<UserRouting> {
    const user = await tx.prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
    if (!user) throw errors.notFound('User');
    const [availability, skills, capacity] = await Promise.all([
      tx.prisma.userAvailability.findUnique({
        where: { tenantId_userId: { tenantId: tx.context.tenantId, userId } },
      }),
      tx.prisma.userSkill.findMany({ where: { userId }, orderBy: { skill: 'asc' } }),
      tx.prisma.userCapacity.findMany({ where: { userId }, orderBy: { object: 'asc' } }),
    ]);
    return {
      userId,
      availability: {
        workingHours: (availability?.workingHours ??
          null) as UserRouting['availability']['workingHours'],
        outOfOffice: availability?.outOfOffice ?? false,
        oooUntil: availability?.oooUntil?.toISOString() ?? null,
      },
      skills: skills.map((s) => s.skill),
      capacity: capacity.map((c) => ({
        object: c.object,
        maxOpen: c.maxOpen,
        maxNewPerDay: c.maxNewPerDay,
      })),
    };
  }

  async putUserRouting(
    tx: TenantTransaction,
    userId: string,
    input: z.output<typeof PutUserRoutingRequest>,
  ): Promise<UserRouting> {
    const before = await this.userRouting(tx, userId);
    const tenantId = tx.context.tenantId;
    if (input.availability) {
      const a = input.availability;
      if (a.workingHours) checkHours('availability.workingHours', a.workingHours);
      const data = {
        workingHours: a.workingHours ? asJson(a.workingHours) : undefined,
        outOfOffice: a.outOfOffice,
        oooUntil: a.outOfOffice && a.oooUntil ? new Date(a.oooUntil) : null,
      };
      await tx.prisma.userAvailability.upsert({
        where: { tenantId_userId: { tenantId, userId } },
        create: { tenantId, userId, ...data },
        update: data,
      });
      if (a.workingHours === null)
        await tx.prisma.$executeRaw`UPDATE user_availability SET working_hours = NULL
          WHERE tenant_id = ${tenantId}::uuid AND user_id = ${userId}::uuid`;
    }
    if (input.skills) {
      await tx.prisma.userSkill.deleteMany({ where: { userId } });
      await tx.prisma.userSkill.createMany({
        data: [...new Set(input.skills)].map((skill) => ({ tenantId, userId, skill })),
      });
    }
    if (input.capacity) {
      const objects = input.capacity.map((c) => c.object);
      if (new Set(objects).size !== objects.length)
        throw errors.validation([
          { field: 'capacity', code: 'duplicate_object', message: 'One limit per object' },
        ]);
      await tx.prisma.userCapacity.deleteMany({ where: { userId } });
      await tx.prisma.userCapacity.createMany({
        data: input.capacity
          .filter((c) => c.maxOpen !== null || c.maxNewPerDay !== null)
          .map((c) => ({ tenantId, userId, ...c })),
      });
    }
    const after = await this.userRouting(tx, userId);
    await audit.setup(tx, {
      action: 'user_routing.updated',
      entityType: 'user',
      entityId: userId,
      before: JSON.parse(JSON.stringify(before)) as Record<string, never>,
      after: JSON.parse(JSON.stringify(after)) as Record<string, never>,
    });
    return after;
  }
}
