import { describe, expect, it } from 'vitest';
import { depreciationAt, depreciationForPeriod, monthsElapsed } from './depreciation.js';

const d = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

// A GHS 12,000 motorbike over 4 years, no salvage — 1,200,000 pesewas / 48.
const bike = {
  cost: 1_200_000,
  salvageValue: 0,
  usefulLifeMonths: 48,
  acquiredOn: '2026-01-15',
};

describe('monthsElapsed', () => {
  it('counts a month only once the day-of-month is reached', () => {
    expect(monthsElapsed(d('2026-01-15'), d('2026-02-14'))).toBe(0);
    expect(monthsElapsed(d('2026-01-15'), d('2026-02-15'))).toBe(1);
    expect(monthsElapsed(d('2026-01-15'), d('2026-03-14'))).toBe(1);
  });

  it('never goes negative for a date before acquisition', () => {
    expect(monthsElapsed(d('2026-06-01'), d('2026-01-01'))).toBe(0);
  });

  it('spans years', () => {
    expect(monthsElapsed(d('2026-01-15'), d('2030-01-15'))).toBe(48);
  });
});

describe('depreciationAt', () => {
  it('charges nothing in the first month', () => {
    const state = depreciationAt(bike, d('2026-02-01'));
    expect(state.accumulated).toBe(0);
    expect(state.netBookValue).toBe(1_200_000);
  });

  it('charges an even amount each elapsed month', () => {
    expect(depreciationAt(bike, d('2026-02-15')).accumulated).toBe(25_000);
    expect(depreciationAt(bike, d('2026-07-15')).accumulated).toBe(150_000);
    expect(depreciationAt(bike, d('2027-01-15')).accumulated).toBe(300_000);
  });

  it('lands exactly on the cost at end of life', () => {
    const state = depreciationAt(bike, d('2030-01-15'));
    expect(state.accumulated).toBe(1_200_000);
    expect(state.netBookValue).toBe(0);
    expect(state.fullyDepreciated).toBe(true);
  });

  it('never depreciates past end of life', () => {
    const state = depreciationAt(bike, d('2035-01-01'));
    expect(state.accumulated).toBe(1_200_000);
    expect(state.netBookValue).toBe(0);
  });

  it('stops at the salvage value rather than writing to zero', () => {
    const withSalvage = { ...bike, salvageValue: 200_000 };
    const state = depreciationAt(withSalvage, d('2030-01-15'));
    expect(state.accumulated).toBe(1_000_000);
    expect(state.netBookValue).toBe(200_000);
  });

  it('absorbs the flooring remainder in the final month', () => {
    // 100,000 over 3 months floors to 33,333/month — 1 pesewa would be lost.
    const odd = { cost: 100_000, salvageValue: 0, usefulLifeMonths: 3, acquiredOn: '2026-01-31' };
    expect(depreciationAt(odd, d('2026-03-31')).accumulated).toBe(66_666);
    const end = depreciationAt(odd, d('2026-04-30'));
    expect(end.accumulated).toBe(100_000);
    expect(end.netBookValue).toBe(0);
  });
});

describe('depreciationForPeriod', () => {
  it('is the charge belonging to that period alone', () => {
    // One month inside the life.
    expect(depreciationForPeriod(bike, d('2026-06-15'), d('2026-07-15'))).toBe(25_000);
    // A quarter.
    expect(depreciationForPeriod(bike, d('2026-04-15'), d('2026-07-15'))).toBe(75_000);
  });

  it('is zero before the asset starts depreciating', () => {
    expect(depreciationForPeriod(bike, d('2026-01-15'), d('2026-02-01'))).toBe(0);
  });

  it('is zero after the asset is fully written off', () => {
    expect(depreciationForPeriod(bike, d('2031-01-01'), d('2032-01-01'))).toBe(0);
  });

  it('sums across every period to exactly the depreciable amount', () => {
    // Month by month over the whole life, including the remainder month.
    let total = 0;
    for (let i = 0; i < 48; i++) {
      const from = new Date(Date.UTC(2026, 0 + i, 15));
      const to = new Date(Date.UTC(2026, 1 + i, 15));
      total += depreciationForPeriod(bike, from, to);
    }
    expect(total).toBe(1_200_000);
  });
});
