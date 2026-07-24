import { describe, expect, it } from 'vitest';
import {
  MIN_BALANCE,
  WITHDRAWAL_FEE,
  availableToWithdraw,
  computeSavingsClosure,
  computeWithdrawal,
} from './savings.js';

describe('availableToWithdraw = balance − 50 − 10, never negative', () => {
  it('reserves min balance and fee', () => {
    expect(availableToWithdraw(10000)).toBe(4000); // GHS 100 → 40
    expect(availableToWithdraw(6001)).toBe(1);
    expect(availableToWithdraw(6000)).toBe(0); // exactly min+fee
    expect(availableToWithdraw(5999)).toBe(0);
    expect(availableToWithdraw(0)).toBe(0);
  });
  it('rejects float balances', () => {
    expect(() => availableToWithdraw(100.5)).toThrow();
  });
});

describe('computeWithdrawal', () => {
  it('debits amount plus flat fee', () => {
    const r = computeWithdrawal(10000, 4000); // withdraw the full available
    expect(r.fee).toBe(WITHDRAWAL_FEE);
    expect(r.totalDebit).toBe(5000);
    expect(r.balanceAfter).toBe(MIN_BALANCE); // lands exactly on the floor
  });

  it('rejects one pesewa over available', () => {
    expect(() => computeWithdrawal(10000, 4001)).toThrow(RangeError);
  });

  it('rejects zero/negative/float amounts', () => {
    expect(() => computeWithdrawal(10000, 0)).toThrow();
    expect(() => computeWithdrawal(10000, -100)).toThrow();
    expect(() => computeWithdrawal(10000, 10.5)).toThrow();
  });

  it('never lets balanceAfter drop below the min balance', () => {
    for (const balance of [6001, 7000, 10000, 100000]) {
      const max = availableToWithdraw(balance);
      if (max > 0) {
        expect(computeWithdrawal(balance, max).balanceAfter).toBeGreaterThanOrEqual(MIN_BALANCE);
      }
    }
  });
});

describe('computeSavingsClosure — fee applies on the closing withdrawal too', () => {
  it('client example: GHS 200 balance → customer receives 190', () => {
    const r = computeSavingsClosure(20000);
    expect(r.fee).toBe(1000);
    expect(r.payout).toBe(19000);
    expect(r.flagged).toBe(false);
  });

  it('releases the min balance', () => {
    const r = computeSavingsClosure(5000); // exactly the min balance
    expect(r.payout).toBe(4000);
  });

  it('balance below the fee → payout 0, flagged, never negative', () => {
    expect(computeSavingsClosure(500)).toEqual({ fee: 500, payout: 0, flagged: true });
    expect(computeSavingsClosure(0)).toEqual({ fee: 0, payout: 0, flagged: true });
  });
});
