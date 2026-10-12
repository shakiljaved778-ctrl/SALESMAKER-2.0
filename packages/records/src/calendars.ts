import type { TenantTransaction } from '@sm/db';

import { ALWAYS_OPEN, type Calendar, type WeeklyHours } from './calendar.js';

/**
 * A tenant's business hours as a Calendar: the given set, else the default set; always open (in
 * the organisation's zone) when there is none.
 */
export async function loadCalendar(
  tx: TenantTransaction,
  businessHoursId: string | null,
): Promise<Calendar> {
  const row = await tx.prisma.businessHours.findFirst({
    where: businessHoursId ? { id: businessHoursId } : { isDefault: true, active: true },
    include: { holidays: { select: { date: true, recurring: true } } },
  });
  if (!row) {
    const settings = await tx.prisma.tenantSettings.findUnique({
      where: { tenantId: tx.context.tenantId },
      select: { defaultTimezone: true },
    });
    return { ...ALWAYS_OPEN, timezone: settings?.defaultTimezone ?? 'UTC' };
  }
  return {
    timezone: row.timezone,
    hours: row.hours as WeeklyHours,
    holidays: row.holidays.map((h) => ({
      date: h.date.toISOString().slice(0, 10),
      recurring: h.recurring,
    })),
  };
}
