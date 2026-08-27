import { describe, expect, it } from 'vitest';
import { bucketKeyOf, bucketKeyOfDay, bucketKeysBetween, isoWeekKey } from './series.service.js';

const at = (iso: string): Date => new Date(`${iso}T12:00:00.000Z`);

describe('isoWeekKey', () => {
  it('numbers weeks from the Monday that starts them', () => {
    // 2026-08-24 is a Monday; the whole week through Sunday shares its key.
    expect(isoWeekKey(at('2026-08-24'))).toBe(isoWeekKey(at('2026-08-30')));
    expect(isoWeekKey(at('2026-08-30'))).not.toBe(isoWeekKey(at('2026-08-31')));
  });

  it('pads the week number so keys sort lexically', () => {
    expect(isoWeekKey(at('2026-01-05'))).toMatch(/^\d{4}-W\d{2}$/);
    const keys = ['2026-01-05', '2026-03-02', '2026-11-02'].map((d) => isoWeekKey(at(d)));
    expect([...keys].sort()).toEqual(keys);
  });

  it('uses the ISO week-numbering year, not the calendar year, at the boundary', () => {
    // 2026-12-31 is a Thursday, so it belongs to week 53 OF 2026 — but
    // 2027-01-01 (Friday) belongs to that same ISO week, carrying the 2026 key.
    expect(isoWeekKey(at('2026-12-31'))).toBe('2026-W53');
    expect(isoWeekKey(at('2027-01-01'))).toBe('2026-W53');
    // And a January date can fall in the previous ISO year's last week.
    expect(isoWeekKey(at('2027-01-04'))).toBe('2027-W01');
  });
});

describe('bucketKeyOf', () => {
  it('produces the key shape each bucket size promises', () => {
    const d = at('2026-08-27');
    expect(bucketKeyOf(d, 'day')).toBe('2026-08-27');
    expect(bucketKeyOf(d, 'month')).toBe('2026-08');
    expect(bucketKeyOf(d, 'week')).toMatch(/^2026-W\d{2}$/);
  });

  it('agrees with the Accra-day-string variant used for reconciliations', () => {
    for (const bucket of ['day', 'week', 'month'] as const) {
      expect(bucketKeyOfDay('2026-08-27', bucket)).toBe(bucketKeyOf(at('2026-08-27'), bucket));
    }
  });
});

describe('bucketKeysBetween', () => {
  it('returns every day in an inclusive range', () => {
    expect(bucketKeysBetween('2026-08-25', '2026-08-28', 'day')).toEqual([
      '2026-08-25',
      '2026-08-26',
      '2026-08-27',
      '2026-08-28',
    ]);
  });

  it('includes months with no activity, so a chart draws a real gap', () => {
    const keys = bucketKeysBetween('2026-01-01', '2026-12-31', 'month');
    expect(keys).toHaveLength(12);
    expect(keys[0]).toBe('2026-01');
    expect(keys[11]).toBe('2026-12');
  });

  it('emits each bucket once even though it walks day by day', () => {
    const keys = bucketKeysBetween('2026-08-01', '2026-08-31', 'month');
    expect(keys).toEqual(['2026-08']);
  });

  it('handles a single-day range', () => {
    expect(bucketKeysBetween('2026-08-27', '2026-08-27', 'day')).toEqual(['2026-08-27']);
  });

  it('returns nothing when the range is inverted', () => {
    // The query schema rejects this first; the helper simply must not hang.
    expect(bucketKeysBetween('2026-08-28', '2026-08-25', 'day')).toEqual([]);
  });

  it('crosses a month boundary without losing either month', () => {
    const keys = bucketKeysBetween('2026-08-30', '2026-09-02', 'month');
    expect(keys).toEqual(['2026-08', '2026-09']);
  });
});
