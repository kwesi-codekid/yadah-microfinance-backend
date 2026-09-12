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

export interface HpFinancing {
  interestAmount: number;
  /** financedAmount + interest — what the customer pays after the deposit. */
  totalPayable: number;
}

/**
 * Client-confirmed (2026-08-02): interest is FLAT, applied ONCE to the
 * financed half. GHS 1,000 outstanding at 10% → owes 1,100 total. Early
 * settlement never reduces it.
 */
export function computeHpFinancing(financedAmount: number, ratePercent: number): HpFinancing {
  assertMoneyInt(financedAmount, 'financedAmount');
  if (!Number.isInteger(ratePercent) || ratePercent < 0 || ratePercent > 100) {
    throw new Error(`ratePercent out of range: ${String(ratePercent)}`);
  }
  const interestAmount = Math.round((financedAmount * ratePercent) / 100);
  return { interestAmount, totalPayable: financedAmount + interestAmount };
}

/**
 * What an agreement is actually priced at.
 *
 * The counter and the customer settle on a figure, which may be above or below
 * what the shelf listed — a television listed at GHS 1,200 and given for GHS
 * 1,000 is a GHS 1,000 agreement, and every figure that follows comes off that.
 * The listed price is kept beside it only so a report can show what was asked.
 *
 * Agreements signed before negotiated pricing carry no agreed price; they fall
 * back to the listed one, which is what they were genuinely built from.
 */
export function agreementPrice(agreement: {
  agreedPrice?: number;
  itemSnapshot: { sellingPrice: number };
}): number {
  return agreement.agreedPrice ?? agreement.itemSnapshot.sellingPrice;
}
