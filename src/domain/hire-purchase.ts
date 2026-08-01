/**
 * Hire purchase money rules as pure functions — integer pesewas.
 * HP guide (client-confirmed): deposit = 50% of the selling price, paid
 * upfront before the item is released; the remaining half is financed.
 * Interest METHOD is an open client question — nothing here computes
 * interest until it's answered (Stage B).
 */

export const HP_ELIGIBILITY_MIN_MONTHS = 3;
export const HP_REDEMPTION_WINDOW_MONTHS = 1;

function assertMoneyInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer (pesewas), got ${String(value)}`);
  }
}

export interface DepositSplit {
  /** Exactly half, rounded UP on an odd pesewa so Yadah never under-collects. */
  depositRequired: number;
  financedAmount: number;
}

export function computeDepositSplit(sellingPrice: number): DepositSplit {
  assertMoneyInt(sellingPrice, 'sellingPrice');
  if (sellingPrice < 2) throw new Error('sellingPrice too small to split');
  const depositRequired = Math.ceil(sellingPrice / 2);
  return { depositRequired, financedAmount: sellingPrice - depositRequired };
}

/** Guard for signing: selling below cost is a pricing mistake, not a sale. */
export function validatePricing(costPrice: number, sellingPrice: number): void {
  assertMoneyInt(costPrice, 'costPrice');
  assertMoneyInt(sellingPrice, 'sellingPrice');
  if (sellingPrice < costPrice) {
    throw new Error('sellingPrice must be at least costPrice');
  }
}
