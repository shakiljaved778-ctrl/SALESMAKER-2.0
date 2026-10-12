import { describe, expect, it } from 'vitest';

import {
  addBusinessMinutes,
  ALWAYS_OPEN,
  businessMinutesBetween,
  hoursErrors,
  isOpen,
  isValidTimezone,
  localParts,
  zonedInstant,
  type Calendar,
} from '../src/calendar.js';

const at = (iso: string) => new Date(iso);
const iso = (d: Date | null) => d?.toISOString() ?? null;

/** Doha (UTC+3, no daylight saving), Sunday to Thursday 08:00–17:00 with a lunch break. */
const doha: Calendar = {
  timezone: 'Asia/Qatar',
  hours: {
    sun: [
      ['08:00', '12:00'],
      ['13:00', '17:00'],
    ],
    mon: [
      ['08:00', '12:00'],
      ['13:00', '17:00'],
    ],
    tue: [
      ['08:00', '12:00'],
      ['13:00', '17:00'],
    ],
    wed: [
      ['08:00', '12:00'],
      ['13:00', '17:00'],
    ],
    thu: [
      ['08:00', '12:00'],
      ['13:00', '17:00'],
    ],
  },
  holidays: [
    { date: '2026-12-18', recurring: true }, // National Day
    { date: '2026-10-14', recurring: false },
  ],
};
/** New York, weekdays 09:00–17:00 (daylight saving ends 2026-11-01, starts 2027-03-14). */
const newYork: Calendar = {
  timezone: 'America/New_York',
  hours: Object.fromEntries(
    (['mon', 'tue', 'wed', 'thu', 'fri'] as const).map((d) => [d, [['09:00', '17:00']]]),
  ),
  holidays: [],
};

describe('local time', () => {
  it('reads wall-clock parts and builds instants, across daylight saving', () => {
    expect(localParts(at('2026-10-12T05:30:00Z'), 'Asia/Qatar')).toEqual({
      date: '2026-10-12',
      weekday: 'mon',
      minutes: 8 * 60 + 30,
    });
    expect(iso(zonedInstant('2026-10-12', 8 * 60, 'Asia/Qatar'))).toBe('2026-10-12T05:00:00.000Z');
    // EDT (UTC−4) before 1 November, EST (UTC−5) after.
    expect(iso(zonedInstant('2026-10-30', 9 * 60, 'America/New_York'))).toBe(
      '2026-10-30T13:00:00.000Z',
    );
    expect(iso(zonedInstant('2026-11-02', 9 * 60, 'America/New_York'))).toBe(
      '2026-11-02T14:00:00.000Z',
    );
    // 01:30 happens twice on 1 November: the earlier one. 02:30 on 14 March never happens.
    expect(iso(zonedInstant('2026-11-01', 90, 'America/New_York'))).toBe(
      '2026-11-01T05:30:00.000Z',
    );
    expect(iso(zonedInstant('2027-03-14', 150, 'America/New_York'))).toBe(
      '2027-03-14T07:30:00.000Z',
    );
    expect(isValidTimezone('Asia/Qatar')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
  });
});

describe('business time', () => {
  it('knows when it is open: hours, breaks, weekends and holidays', () => {
    expect(isOpen(at('2026-10-12T06:00:00Z'), doha)).toBe(true); // Mon 09:00
    expect(isOpen(at('2026-10-12T09:30:00Z'), doha)).toBe(false); // lunch
    expect(isOpen(at('2026-10-12T14:00:00Z'), doha)).toBe(false); // 17:00, end exclusive
    expect(isOpen(at('2026-10-16T06:00:00Z'), doha)).toBe(false); // Friday
    expect(isOpen(at('2026-10-14T06:00:00Z'), doha)).toBe(false); // one-off holiday
    expect(isOpen(at('2027-12-18T06:00:00Z'), doha)).toBe(false); // recurring holiday
    expect(isOpen(at('2026-10-16T06:00:00Z'), ALWAYS_OPEN)).toBe(true);
  });

  it('adds business minutes over breaks, nights, weekends and holidays', () => {
    // Mon 11:30 + 60 min: 30 before lunch, 30 after → 13:30.
    expect(iso(addBusinessMinutes(at('2026-10-12T08:30:00Z'), 60, doha))).toBe(
      '2026-10-12T10:30:00.000Z',
    );
    // Tue 16:30 + 60: 30 today; Wednesday is a holiday; Thursday 08:30.
    expect(iso(addBusinessMinutes(at('2026-10-13T13:30:00Z'), 60, doha))).toBe(
      '2026-10-15T05:30:00.000Z',
    );
    // Thu 16:00 + 120: 60 today, then the weekend (Fri, Sat), Sunday 09:00.
    expect(iso(addBusinessMinutes(at('2026-10-15T13:00:00Z'), 120, doha))).toBe(
      '2026-10-18T06:00:00.000Z',
    );
    // From a closed instant, zero minutes is the next opening.
    expect(iso(addBusinessMinutes(at('2026-10-16T10:00:00Z'), 0, doha))).toBe(
      '2026-10-18T05:00:00.000Z',
    );
    // Friday 16:00 EDT + 2 h: Monday after daylight saving ends, 10:00 EST.
    expect(iso(addBusinessMinutes(at('2026-10-30T20:00:00Z'), 120, newYork))).toBe(
      '2026-11-02T15:00:00.000Z',
    );
    expect(iso(addBusinessMinutes(at('2026-10-30T20:00:00Z'), 90, ALWAYS_OPEN))).toBe(
      '2026-10-30T21:30:00.000Z',
    );
    expect(addBusinessMinutes(at('2026-10-30T20:00:00Z'), 10, { ...doha, hours: {} })).toBeNull();
  });

  it('counts business minutes between instants', () => {
    expect(
      businessMinutesBetween(at('2026-10-12T08:30:00Z'), at('2026-10-12T10:30:00Z'), doha),
    ).toBe(60);
    expect(
      businessMinutesBetween(at('2026-10-15T13:00:00Z'), at('2026-10-18T06:00:00Z'), doha),
    ).toBe(120);
    expect(
      businessMinutesBetween(at('2026-10-18T06:00:00Z'), at('2026-10-15T13:00:00Z'), doha),
    ).toBe(-120);
    // A whole New York week across the change: five 8-hour days.
    expect(
      businessMinutesBetween(at('2026-10-29T00:00:00Z'), at('2026-11-05T00:00:00Z'), newYork),
    ).toBe(5 * 8 * 60);
  });

  it('checks weekly hours', () => {
    expect(
      hoursErrors({
        mon: [
          ['08:00', '12:00'],
          ['13:00', '24:00'],
        ],
      }),
    ).toEqual([]);
    expect(
      hoursErrors({
        mon: [['8:00', '12:00']],
        tue: [['12:00', '09:00']],
        wed: [
          ['08:00', '12:00'],
          ['11:00', '13:00'],
        ],
        xyz: [],
      } as never),
    ).toEqual([
      { field: 'mon.0', code: 'invalid_time' },
      { field: 'tue.0', code: 'ends_before_start' },
      { field: 'wed.1', code: 'overlaps' },
      { field: 'xyz', code: 'unknown_day' },
    ]);
  });
});
