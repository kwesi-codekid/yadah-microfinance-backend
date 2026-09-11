import { describe, expect, it } from 'vitest';
import { TXN_TYPES, directionOf, isRevenueFee, moduleOf } from './transactions.js';

describe('moduleOf', () => {
  it('maps every type to its module', () => {
    expect(moduleOf('susu-deposit')).toBe('susu');
    expect(moduleOf('susu-payout')).toBe('susu');
    expect(moduleOf('savings-deposit')).toBe('savings');
    expect(moduleOf('savings-withdrawal')).toBe('savings');
    expect(moduleOf('savings-closure')).toBe('savings');
    expect(moduleOf('loan-disbursement')).toBe('loans');
    expect(moduleOf('loan-repayment')).toBe('loans');
    expect(moduleOf('hp-deposit')).toBe('hire-purchase');
    expect(moduleOf('hp-installment')).toBe('hire-purchase');
    expect(moduleOf('hp-redemption')).toBe('hire-purchase');
    expect(moduleOf('transfer')).toBe('transfers');
  });
});

describe('directionOf — company cash perspective', () => {
  it('cash receipts are in', () => {
    expect(directionOf('susu-deposit', 'cash', null)).toBe('in');
    expect(directionOf('savings-deposit', 'cash', null)).toBe('in');
    expect(directionOf('hp-deposit', 'cash', null)).toBe('in');
    expect(directionOf('hp-installment', 'cash', null)).toBe('in');
    expect(directionOf('hp-redemption', 'cash', null)).toBe('in');
    expect(directionOf('loan-repayment', 'cash', 'cash')).toBe('in');
  });

  it('cash handed to the customer is out', () => {
    expect(directionOf('savings-withdrawal', 'cash', null)).toBe('out');
    expect(directionOf('savings-closure', 'cash', null)).toBe('out');
    expect(directionOf('susu-payout', null, 'cash')).toBe('out');
    expect(directionOf('loan-disbursement', 'cash', null)).toBe('out');
  });

  it('transfer legs are internal — never counted as cash', () => {
    // Deposit legs written by the transfers service carry channel 'transfer'.
    expect(directionOf('susu-deposit', 'transfer', null)).toBe('internal');
    expect(directionOf('savings-deposit', 'transfer', null)).toBe('internal');
    expect(directionOf('savings-withdrawal', 'transfer', null)).toBe('internal');
    expect(directionOf('hp-installment', 'transfer', null)).toBe('internal');
    // Payout legs point at an internal destination instead of 'cash'.
    expect(directionOf('susu-payout', null, 'savings')).toBe('internal');
    expect(directionOf('susu-payout', null, 'loan')).toBe('internal');
    expect(directionOf('susu-payout', null, 'hire-purchase')).toBe('internal');
    // Repayments funded by the customer's own products.
    expect(directionOf('loan-repayment', 'transfer', 'susu-closure')).toBe('internal');
    expect(directionOf('loan-repayment', 'transfer', 'transfer')).toBe('internal');
    // The transfer cross-reference row itself.
    expect(directionOf('transfer', null, 'susu->loan')).toBe('internal');
  });

  it('momo/paystack channels count as in, like cash', () => {
    expect(directionOf('susu-deposit', 'momo', null)).toBe('in');
    expect(directionOf('savings-deposit', 'paystack', null)).toBe('in');
  });

  it('every type resolves to a direction (exhaustive)', () => {
    for (const type of TXN_TYPES) {
      expect(['in', 'out', 'internal']).toContain(directionOf(type, null, null));
    }
  });
});

describe('isRevenueFee', () => {
  it('counts the charges the company keeps', () => {
    expect(isRevenueFee('savings-withdrawal')).toBe(true);
    expect(isRevenueFee('savings-closure')).toBe(true);
    expect(isRevenueFee('susu-payout')).toBe(true);
  });

  it('excludes the transfer leg, which only mirrors the savings fee', () => {
    expect(isRevenueFee('transfer')).toBe(false);
  });

  it('excludes a partial susu withdrawal, which charges nothing', () => {
    expect(isRevenueFee('susu-withdrawal')).toBe(false);
  });

  it('excludes every money-in type', () => {
    for (const t of ['susu-deposit', 'savings-deposit', 'loan-repayment', 'hp-sale'] as const) {
      expect(isRevenueFee(t)).toBe(false);
    }
  });
});
