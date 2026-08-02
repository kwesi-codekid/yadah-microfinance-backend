import { describe, expect, it } from 'vitest';
import { computeDepositSplit, computeHpFinancing, validatePricing } from './hire-purchase.js';

describe('computeHpFinancing — flat interest, once, on the financed half', () => {
  it("client's example: 1,000 outstanding at 10% → owes 1,100", () => {
    expect(computeHpFinancing(100_000, 10)).toEqual({
      interestAmount: 10_000,
      totalPayable: 110_000,
    });
  });
  it('zero rate → totalPayable equals financed', () => {
    expect(computeHpFinancing(100_000, 0)).toEqual({ interestAmount: 0, totalPayable: 100_000 });
  });
  it('rounds on odd amounts', () => {
    expect(computeHpFinancing(100_005, 10).interestAmount).toBe(10_001); // 10000.5 → 10001
  });
  it('rejects floats and bad rates', () => {
    expect(() => computeHpFinancing(100.5, 10)).toThrow();
    expect(() => computeHpFinancing(100_000, 101)).toThrow();
  });
});

describe('computeDepositSplit — 50% deposit, rounded up', () => {
  it('splits an even price exactly in half', () => {
    expect(computeDepositSplit(200_000)).toEqual({
      depositRequired: 100_000,
      financedAmount: 100_000,
    }); // GHS 2,000 fridge → 1,000 + 1,000
  });

  it('rounds the deposit UP on an odd pesewa (never under-collects)', () => {
    expect(computeDepositSplit(100_001)).toEqual({
      depositRequired: 50_001,
      financedAmount: 50_000,
    });
  });

  it('deposit + financed always equals the selling price', () => {
    for (const price of [2, 3, 999, 100_000, 123_457, 5_000_000]) {
      const { depositRequired, financedAmount } = computeDepositSplit(price);
      expect(depositRequired + financedAmount).toBe(price);
      expect(depositRequired).toBeGreaterThanOrEqual(financedAmount);
    }
  });

  it('rejects floats and absurd inputs', () => {
    expect(() => computeDepositSplit(100.5)).toThrow();
    expect(() => computeDepositSplit(1)).toThrow();
    expect(() => computeDepositSplit(-100)).toThrow();
  });
});

describe('validatePricing', () => {
  it('accepts selling ≥ cost (equal is allowed — office duplicates the number)', () => {
    expect(() => {
      validatePricing(100_000, 100_000);
    }).not.toThrow();
    expect(() => {
      validatePricing(100_000, 150_000);
    }).not.toThrow();
  });
  it('refuses selling below cost', () => {
    expect(() => {
      validatePricing(100_000, 99_999);
    }).toThrow();
  });
});
