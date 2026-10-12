/*
 * Business-time arithmetic (§7.3, P03 T11): open hours per weekday in a time zone, holidays, and
 * the SLA questions asked of them (is it open now, what instant is N business minutes after this
 * one, how many business minutes lie between two instants). Instants are UTC `Date`s; wall-clock
 * times are local to the calendar's zone, daylight-saving changes included (through Intl, no
 * library). Pure functions: the database is never read here.
 */

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
/** `HH:MM` local, end exclusive; `24:00` closes at midnight. */
export type WeeklyHours = Partial<Record<Weekday, readonly (readonly [string, string])[]>>;

export interface Holiday {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Every year on the same month and day. */
  recurring: boolean;
}

export interface Calendar {
  timezone: string;
  /** Null: open around the clock (holidays still close it). */
  hours: WeeklyHours | null;
  holidays: readonly Holiday[];
}

/** Open around the clock, in UTC: the calendar of a policy without business hours. */
export const ALWAYS_OPEN: Calendar = { timezone: 'UTC', hours: null, holidays: [] };

const MINUTE = 60_000;
const DAY_MINUTES = 1440;
/** How far ahead to look for open time before giving up (a calendar with no open hours). */
const MAX_DAYS = 3 * 366;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/;
const toMinutes = (t: string) => {
  if (t === '24:00') return DAY_MINUTES;
  const [h = '0', m = '0'] = t.split(':');
  return Number(h) * 60 + Number(m);
};

/** Problems with weekly hours: bad times, empty or reversed intervals, overlaps. */
export function hoursErrors(hours: WeeklyHours): { field: string; code: string }[] {
  const errors: { field: string; code: string }[] = [];
  for (const [day, intervals] of Object.entries(hours)) {
    if (!(WEEKDAYS as readonly string[]).includes(day)) {
      errors.push({ field: day, code: 'unknown_day' });
      continue;
    }
    const sorted = [...intervals].sort((a, b) => toMinutes(a[0]) - toMinutes(b[0]));
    let end = -1;
    for (const [i, [from, to]] of sorted.entries()) {
      if (!TIME.test(from) || !TIME.test(to) || from === '24:00') {
        errors.push({ field: `${day}.${String(i)}`, code: 'invalid_time' });
        continue;
      }
      if (toMinutes(to) <= toMinutes(from))
        errors.push({ field: `${day}.${String(i)}`, code: 'ends_before_start' });
      if (toMinutes(from) < end) errors.push({ field: `${day}.${String(i)}`, code: 'overlaps' });
      end = Math.max(end, toMinutes(to));
    }
  }
  return errors;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

const formats = new Map<string, Intl.DateTimeFormat>();
function formatFor(timezone: string): Intl.DateTimeFormat {
  let format = formats.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formats.set(timezone, format);
  }
  return format;
}

export interface LocalParts {
  /** `YYYY-MM-DD`. */
  date: string;
  weekday: Weekday;
  /** Minutes since local midnight. */
  minutes: number;
}

/** The wall-clock date, weekday and minute of an instant in a zone. */
export function localParts(instant: Date, timezone: string): LocalParts {
  const parts = formatFor(timezone).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday: get('weekday').toLowerCase().slice(0, 3) as Weekday,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

/** The zone's offset from UTC at an instant, in minutes (Doha: +180). */
function offsetAt(instant: Date, timezone: string): number {
  const parts = formatFor(timezone).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / MINUTE);
}

/**
 * The instant of a local wall-clock time. A time that does not exist (skipped by a
 * daylight-saving change) lands just after the gap; an ambiguous one takes the earlier instant.
 */
export function zonedInstant(date: string, minutes: number, timezone: string): Date {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d) + minutes * MINUTE;
  // The offsets in force a day either side: at most one change lies between them.
  const candidates = [
    ...new Set(
      [-86_400_000, 86_400_000].map((shift) => offsetAt(new Date(wall + shift), timezone)),
    ),
  ]
    .map((offset) => wall - offset * MINUTE)
    .sort((a, b) => a - b);
  const target = { date, minutes: minutes % DAY_MINUTES };
  const valid = candidates.filter((c) => {
    const local = localParts(new Date(c), timezone);
    return local.date === target.date && local.minutes === target.minutes;
  });
  // Ambiguous: the earlier. Skipped: the later candidate, which falls just after the gap.
  return new Date(valid[0] ?? candidates.at(-1) ?? wall);
}

const nextDate = (date: string, days = 1) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const weekdayOf = (date: string): Weekday =>
  WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? 'sun';

export function isHoliday(date: string, holidays: readonly Holiday[]): boolean {
  return holidays.some(
    (h) => h.date === date || (h.recurring && h.date.slice(5) === date.slice(5)),
  );
}

/** A local date's open intervals as instants, in order (none on a holiday). */
export function openIntervals(date: string, calendar: Calendar): [Date, Date][] {
  if (isHoliday(date, calendar.holidays)) return [];
  const intervals: readonly (readonly [string, string])[] = calendar.hours
    ? (calendar.hours[weekdayOf(date)] ?? [])
    : [['00:00', '24:00']];
  return [...intervals]
    .sort((a, b) => toMinutes(a[0]) - toMinutes(b[0]))
    .map(([from, to]) => [
      zonedInstant(date, toMinutes(from), calendar.timezone),
      to === '24:00'
        ? zonedInstant(nextDate(date), 0, calendar.timezone)
        : zonedInstant(date, toMinutes(to), calendar.timezone),
    ]);
}

export function isOpen(instant: Date, calendar: Calendar): boolean {
  const { date } = localParts(instant, calendar.timezone);
  return openIntervals(date, calendar).some(([a, b]) => instant >= a && instant < b);
}

/**
 * The instant `minutes` business minutes after `start` (§7.3 SLA due times). Zero minutes from a
 * closed instant is the next opening. Null when the calendar is never open.
 */
export function addBusinessMinutes(start: Date, minutes: number, calendar: Calendar): Date | null {
  let remaining = Math.max(0, minutes) * MINUTE;
  let date = localParts(start, calendar.timezone).date;
  // The local day before can still be open at `start` (an interval ending at 24:00 across a change).
  date = nextDate(date, -1);
  for (let i = 0; i < MAX_DAYS; i += 1, date = nextDate(date)) {
    for (const [from, to] of openIntervals(date, calendar)) {
      if (to <= start) continue;
      const begin = from > start ? from : start;
      const available = to.getTime() - begin.getTime();
      if (remaining === 0 || remaining < available) return new Date(begin.getTime() + remaining);
      remaining -= available;
    }
  }
  return null;
}

/** Business minutes between two instants (negative when `to` is before `from`). */
export function businessMinutesBetween(from: Date, to: Date, calendar: Calendar): number {
  if (to < from) return -businessMinutesBetween(to, from, calendar);
  let total = 0;
  let date = nextDate(localParts(from, calendar.timezone).date, -1);
  const last = localParts(to, calendar.timezone).date;
  for (let i = 0; i < MAX_DAYS && date <= last; i += 1, date = nextDate(date))
    for (const [a, b] of openIntervals(date, calendar)) {
      const begin = Math.max(a.getTime(), from.getTime());
      const end = Math.min(b.getTime(), to.getTime());
      if (end > begin) total += end - begin;
    }
  return Math.round(total / MINUTE);
}
