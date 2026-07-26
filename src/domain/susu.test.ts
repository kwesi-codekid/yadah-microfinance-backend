import { describe, expect, it } from 'vitest';
import { formatGhs } from '../lib/money.js';
import {
  SUSU_CYCLE_DEPOSITS,
  SUSU_MIN_DAILY_AMOUNT,
  computeClosure,
  computeDepositAmount,
  remainingDeposits,
} from './susu.js';

describe('SUSU_MIN_DAILY_AMOUNT', () => {
  it('is GHS 5 in pesewas', () => {
    expect(SUSU_MIN_DAILY_AMOUNT).toBe(500);
  });
});

describe('computeDepositAmount', () => {
  it('multiplies daily amount by days covered', () => {
    expect(computeDepositAmount(2000, 1)).toBe(2000);
    expect(computeDepositAmount(2000, 3)).toBe(6000); // catch-up
    expect(computeDepositAmount(2000, 31)).toBe(62000); // whole cycle at once
  });

  it('rejects non-integer money and invalid day counts', () => {
    expect(() => computeDepositAmount(20.5, 1)).toThrow();
    expect(() => computeDepositAmount(2000, 0)).toThrow();
    expect(() => computeDepositAmount(2000, 1.5)).toThrow();
    expect(() => computeDepositAmount(-2000, 1)).toThrow();
  });
});

describe('computeClosure — commission is exactly 1 day, payout never negative', () => {
  it('completed cycle: payout = 30 days', () => {
    const r = computeClosure(62000, 2000); // 31 deposits of GHS 20
    expect(r.commission).toBe(2000);
    expect(r.payout).toBe(60000);
    expect(r.flagged).toBe(false);
  });

  it('early exit day 2: payout = 1 day', () => {
    const r = computeClosure(4000, 2000);
    expect(r.commission).toBe(2000);
    expect(r.payout).toBe(2000);
    expect(r.flagged).toBe(false);
  });

  it('exit day 1: payout 0, not flagged (commission fully covered)', () => {
    const r = computeClosure(2000, 2000);
    expect(r.commission).toBe(2000);
    expect(r.payout).toBe(0);
    expect(r.flagged).toBe(false);
  });

  it('zero deposits: payout 0, commission 0, flagged', () => {
    const r = computeClosure(0, 2000);
    expect(r.commission).toBe(0);
    expect(r.payout).toBe(0);
    expect(r.flagged).toBe(true);
  });

  it('never returns negative payout', () => {
    for (const total of [0, 1, 1999, 2000, 2001, 61999, 62000]) {
      expect(computeClosure(total, 2000).payout).toBeGreaterThanOrEqual(0);
    }
  });

  it('rejects float money', () => {
    expect(() => computeClosure(100.5, 2000)).toThrow();
    expect(() => computeClosure(4000, 20.5)).toThrow();
  });
});

describe('remainingDeposits', () => {
  it('counts down from 31', () => {
    expect(remainingDeposits(0)).toBe(SUSU_CYCLE_DEPOSITS);
    expect(remainingDeposits(29)).toBe(2);
    expect(remainingDeposits(31)).toBe(0);
  });
  it('rejects out-of-range counts', () => {
    expect(() => remainingDeposits(32)).toThrow();
    expect(() => remainingDeposits(-1)).toThrow();
  });
});

describe('formatGhs (presentation boundary)', () => {
  it('formats pesewas as GHS', () => {
    expect(formatGhs(1050)).toBe('GHS 10.50');
    expect(formatGhs(0)).toBe('GHS 0.00');
    expect(formatGhs(5)).toBe('GHS 0.05');
    expect(formatGhs(123456789)).toBe('GHS 1,234,567.89');
  });
  it('rejects floats', () => {
    expect(() => formatGhs(10.5)).toThrow();
  });
});
