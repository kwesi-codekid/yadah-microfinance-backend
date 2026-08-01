import { describe, expect, it } from 'vitest';
import {
  addMonthsClamped,
  allocateRepayment,
  buildSchedule,
  computeInterest,
  escalationActionFor,
  tierFor,
} from './loans.js';

describe('tierFor — boundaries exactly as client confirmed', () => {
  it('small: 1,000–20,000 GHS', () => {
    expect(tierFor(100_000)).toBe('small');
    expect(tierFor(2_000_000)).toBe('small'); // exactly 20,000
  });
  it('big: over 20,000 up to 50,000', () => {
    expect(tierFor(2_000_100)).toBe('big'); // 20,001
    expect(tierFor(2_000_001)).toBe('big'); // even one pesewa over
    expect(tierFor(5_000_000)).toBe('big'); // exactly 50,000
  });
  it('outside range → null (refused)', () => {
    expect(tierFor(99_900)).toBeNull(); // 999
    expect(tierFor(5_000_100)).toBeNull(); // 50,001
    expect(tierFor(0)).toBeNull();
  });
});

describe('computeInterest — flat on principal', () => {
  it('exact for the three confirmed rates', () => {
    expect(computeInterest(100_000, 10)).toBe(10_000); // 1,000 → 100
    expect(computeInterest(100_000, 20)).toBe(20_000);
    expect(computeInterest(100_000, 30)).toBe(30_000);
  });
  it('rounds on odd principals', () => {
    expect(computeInterest(100_001, 10)).toBe(10_000); // 10000.1 → 10000
    expect(computeInterest(100_005, 10)).toBe(10_001); // 10000.5 → 10001
  });
  it('rejects floats', () => {
    expect(() => computeInterest(100.5, 10)).toThrow();
  });
});

describe('addMonthsClamped', () => {
  it('steps plain months', () => {
    expect(addMonthsClamped(new Date('2026-08-15T00:00:00Z'), 1).toISOString()).toBe(
      '2026-09-15T00:00:00.000Z',
    );
  });
  it('clamps Jan 31 → Feb 28', () => {
    expect(addMonthsClamped(new Date('2026-01-31T00:00:00Z'), 1).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
  });
  it('clamps into leap February', () => {
    expect(addMonthsClamped(new Date('2028-01-31T00:00:00Z'), 1).toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });
});

describe('buildSchedule — sums exactly to totalDue', () => {
  it('even split', () => {
    const s = buildSchedule(330_000, 3, new Date('2026-08-01T00:00:00Z'));
    expect(s.map((l) => l.amountDue)).toEqual([110_000, 110_000, 110_000]);
  });
  it('remainder folds into the last instalment', () => {
    const s = buildSchedule(100_000, 3, new Date('2026-08-01T00:00:00Z'));
    expect(s.map((l) => l.amountDue)).toEqual([33_333, 33_333, 33_334]);
    expect(s.reduce((sum, l) => sum + l.amountDue, 0)).toBe(100_000);
  });
  it('due dates step monthly', () => {
    const s = buildSchedule(300, 3, new Date('2026-08-31T00:00:00Z'));
    expect(s[0]?.dueDate.toISOString()).toBe('2026-09-30T00:00:00.000Z'); // clamped
    expect(s[2]?.dueDate.toISOString()).toBe('2026-11-30T00:00:00.000Z');
  });
});

describe('escalationActionFor — the ladder, boundary-exact', () => {
  const start = new Date('2026-01-15T00:00:00Z');

  it('on the boundary day itself: nothing (not yet overdue)', () => {
    expect(escalationActionFor(10, start, new Date('2026-04-15T00:00:00Z'))).toBeNull();
  });
  it('one ms past the boundary: escalates 10 → 20', () => {
    expect(escalationActionFor(10, start, new Date('2026-04-15T00:00:00.001Z'))).toEqual({
      type: 'escalate',
      newRatePercent: 20,
    });
  });
  it('20% covers to month 6, then → 30', () => {
    expect(escalationActionFor(20, start, new Date('2026-07-15T00:00:00Z'))).toBeNull();
    expect(escalationActionFor(20, start, new Date('2026-07-16T00:00:00Z'))).toEqual({
      type: 'escalate',
      newRatePercent: 30,
    });
  });
  it('30% covers to month 12, then → freeze', () => {
    expect(escalationActionFor(30, start, new Date('2027-01-15T00:00:00Z'))).toBeNull();
    expect(escalationActionFor(30, start, new Date('2027-01-16T00:00:00Z'))).toEqual({
      type: 'freeze',
    });
  });
});

describe('allocateRepayment — oldest first, partials allowed', () => {
  it('fills instalments in order', () => {
    const lines = [
      { amountDue: 100, amountPaid: 0 },
      { amountDue: 100, amountPaid: 0 },
      { amountDue: 100, amountPaid: 0 },
    ];
    expect(allocateRepayment(lines, 250)).toEqual([100, 100, 50]);
  });
  it('respects already-paid portions', () => {
    const lines = [
      { amountDue: 100, amountPaid: 100 },
      { amountDue: 100, amountPaid: 30 },
    ];
    expect(allocateRepayment(lines, 50)).toEqual([0, 50]);
  });
  it('caps at what is owed', () => {
    const lines = [{ amountDue: 100, amountPaid: 0 }];
    expect(allocateRepayment(lines, 500)).toEqual([100]);
  });
});
