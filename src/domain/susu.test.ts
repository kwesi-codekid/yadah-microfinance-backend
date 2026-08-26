import { describe, expect, it } from 'vitest';
import { formatGhs } from '../lib/money.js';
import {
  SUSU_CYCLE_DEPOSITS,
  SUSU_MIN_DAILY_AMOUNT,
  computeClosure,
  computeDepositAmount,
  computePartialWithdrawal,
  maxPartialWithdrawal,
  remainingDeposits,
  susuBalance,
} from './susu.js';

describe('SUSU_MIN_DAILY_AMOUNT', () => {
  it('is GHS 10 in pesewas', () => {
    expect(SUSU_MIN_DAILY_AMOUNT).toBe(1000);
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

describe('susuBalance', () => {
  it('is what came in less what was taken out', () => {
    expect(susuBalance(31_000, 0)).toBe(31_000);
    expect(susuBalance(31_000, 10_000)).toBe(21_000);
    expect(susuBalance(31_000, 31_000)).toBe(0);
  });

  it('refuses to report a negative balance', () => {
    expect(() => susuBalance(10_000, 10_001)).toThrow(/exceeds totalDeposited/);
  });

  it('rejects non-integer money', () => {
    expect(() => susuBalance(10_000.5, 0)).toThrow();
    expect(() => susuBalance(10_000, -1)).toThrow();
  });
});

describe('maxPartialWithdrawal — the commission reserve', () => {
  const daily = 1_000;

  it('holds back exactly one day so the closing commission stays collectible', () => {
    expect(maxPartialWithdrawal(31_000, daily)).toBe(30_000);
    expect(maxPartialWithdrawal(2_000, daily)).toBe(1_000);
  });

  it('offers nothing once the balance is down to the reserve', () => {
    expect(maxPartialWithdrawal(1_000, daily)).toBe(0);
    expect(maxPartialWithdrawal(0, daily)).toBe(0);
  });

  it('never goes negative when the balance is below one day', () => {
    expect(maxPartialWithdrawal(400, daily)).toBe(0);
  });
});

describe('computePartialWithdrawal', () => {
  const daily = 1_000;

  it('moves money out and takes no commission', () => {
    const result = computePartialWithdrawal(31_000, daily, 5_000);
    expect(result.balanceAfter).toBe(26_000);
    expect(result.reserved).toBe(daily);
  });

  it('allows draining down to exactly the reserve', () => {
    expect(computePartialWithdrawal(31_000, daily, 30_000).balanceAfter).toBe(1_000);
  });

  it('refuses one pesewa past the reserve', () => {
    expect(() => computePartialWithdrawal(31_000, daily, 30_001)).toThrow(RangeError);
  });

  it('refuses any withdrawal once the balance is only the reserve', () => {
    expect(() => computePartialWithdrawal(1_000, daily, 1)).toThrow(RangeError);
  });

  it('rejects zero, negative and fractional amounts', () => {
    expect(() => computePartialWithdrawal(31_000, daily, 0)).toThrow();
    expect(() => computePartialWithdrawal(31_000, daily, -100)).toThrow();
    expect(() => computePartialWithdrawal(31_000, daily, 100.5)).toThrow();
  });
});

describe('commission survives partial withdrawals (client rule 2026-08-21)', () => {
  const daily = 1_000;

  it('still takes exactly one day at closure, however much was withdrawn', () => {
    // Full cycle, nothing withdrawn.
    const untouched = computeClosure(susuBalance(31_000, 0), daily);
    expect(untouched.commission).toBe(1_000);
    expect(untouched.payout).toBe(30_000);

    // Same cycle, but GHS 200 was taken along the way.
    const withdrawn = computeClosure(susuBalance(31_000, 20_000), daily);
    expect(withdrawn.commission).toBe(1_000);
    expect(withdrawn.payout).toBe(10_000);
  });

  it('leaves the commission exactly covered when drained to the reserve', () => {
    const balance = computePartialWithdrawal(31_000, daily, 30_000).balanceAfter;
    const closure = computeClosure(balance, daily);
    expect(closure.commission).toBe(1_000);
    expect(closure.payout).toBe(0);
    expect(closure.flagged).toBe(false);
  });

  it('is charged once per cycle, not once per withdrawal', () => {
    // Three withdrawals totalling 25,000 out of 31,000.
    let balance = susuBalance(31_000, 0);
    for (const amount of [10_000, 10_000, 5_000]) {
      balance = computePartialWithdrawal(balance, daily, amount).balanceAfter;
    }
    expect(balance).toBe(6_000);
    const closure = computeClosure(balance, daily);
    expect(closure.commission).toBe(1_000); // one day, not three
    expect(closure.payout).toBe(5_000);
  });
});
