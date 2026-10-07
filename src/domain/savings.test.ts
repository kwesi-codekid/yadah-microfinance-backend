import { describe, expect, it } from 'vitest';
import {
  MIN_BALANCE,
  WITHDRAWAL_FEE,
  availableToWithdraw,
  computeSavingsClosure,
  computeWithdrawal,
  earliestMaturity,
  isMatured,
} from './savings.js';

/** What a withdrawal cannot touch: the floor plus the fee that funds it. */
const RESERVED = MIN_BALANCE + WITHDRAWAL_FEE;

describe('availableToWithdraw = balance − the floor − the fee, never negative', () => {
  it('reserves min balance and fee', () => {
    // Derived from the constants rather than written out, so lowering the
    // floor is a one-line change and these keep testing the rule.
    expect(availableToWithdraw(10_000)).toBe(10_000 - RESERVED);
    expect(availableToWithdraw(RESERVED + 1)).toBe(1);
    expect(availableToWithdraw(RESERVED)).toBe(0); // exactly the reserve
    expect(availableToWithdraw(RESERVED - 1)).toBe(0);
    expect(availableToWithdraw(0)).toBe(0);
  });
  it('rejects float balances', () => {
    expect(() => availableToWithdraw(100.5)).toThrow();
  });
});

describe('computeWithdrawal', () => {
  it('debits amount plus flat fee', () => {
    const max = availableToWithdraw(10_000); // withdraw the full available
    const r = computeWithdrawal(10_000, max);
    expect(r.fee).toBe(WITHDRAWAL_FEE);
    expect(r.totalDebit).toBe(max + WITHDRAWAL_FEE);
    expect(r.balanceAfter).toBe(MIN_BALANCE); // lands exactly on the floor
  });

  it('rejects one pesewa over available', () => {
    expect(() => computeWithdrawal(10_000, availableToWithdraw(10_000) + 1)).toThrow(RangeError);
  });

  it('rejects zero/negative/float amounts', () => {
    expect(() => computeWithdrawal(10000, 0)).toThrow();
    expect(() => computeWithdrawal(10000, -100)).toThrow();
    expect(() => computeWithdrawal(10000, 10.5)).toThrow();
  });

  it('never lets balanceAfter drop below the min balance', () => {
    for (const balance of [RESERVED + 1, 7_000, 10_000, 100_000]) {
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

describe('fixed deposits', () => {
  const fixed = { accountType: 'fixed', maturesOn: '2027-04-06' };

  it('matures on its maturity day, not the day before', () => {
    expect(isMatured(fixed, '2027-04-05')).toBe(false);
    expect(isMatured(fixed, '2027-04-06')).toBe(true);
    expect(isMatured(fixed, '2030-01-01')).toBe(true);
  });

  it('never matures anything that is not a fixed deposit', () => {
    expect(isMatured({ accountType: 'standard', maturesOn: '2000-01-01' }, '2027-01-01')).toBe(
      false,
    );
    expect(isMatured({ accountType: 'fixed' }, '2027-01-01')).toBe(false);
  });

  it('runs at least six months, clamped to the end of a short month', () => {
    expect(earliestMaturity('2026-10-06')).toBe('2027-04-06');
    expect(earliestMaturity('2026-08-31')).toBe('2027-02-28');
  });

  it('charges the normal fee and keeps the floor until it matures', () => {
    expect(availableToWithdraw(20_000, false)).toBe(20_000 - RESERVED);
    expect(computeWithdrawal(20_000, 5_000, false).fee).toBe(WITHDRAWAL_FEE);
  });

  it('once matured, pays out all of it with no fee', () => {
    expect(availableToWithdraw(20_000, true)).toBe(20_000);
    expect(computeWithdrawal(20_000, 20_000, true)).toEqual({
      fee: 0,
      totalDebit: 20_000,
      balanceAfter: 0,
    });
    expect(computeSavingsClosure(20_000, true)).toEqual({ fee: 0, payout: 20_000, flagged: false });
    expect(computeSavingsClosure(0, true).flagged).toBe(false);
  });
});
