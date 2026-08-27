/**
 * Straight-line depreciation, computed rather than posted.
 *
 * The depreciable amount (cost less salvage value) is spread evenly across the
 * useful life, one whole month at a time. A month counts once it has fully
 * elapsed since acquisition, so an asset bought on the 20th starts
 * depreciating on the 20th of the following month — no part-month
 * apportionment, which keeps every figure an exact integer number of pesewas
 * and avoids rounding drift over a ten-year life.
 *
 * All amounts are integer pesewas.
 */

/** Whole months from `from` to `to`, never negative. Day-of-month aware. */
export function monthsElapsed(from: Date, to: Date): number {
  const months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (months <= 0) return 0;

  // The anniversary day, CLAMPED to the length of the month being tested: an
  // asset acquired on the 31st has no 31st in April, so its April anniversary
  // is the 30th. Without the clamp such an asset loses a month every short
  // month and never fully depreciates.
  const daysInMonth = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() + 1, 0)).getUTCDate();
  const anniversaryDay = Math.min(from.getUTCDate(), daysInMonth);

  return to.getUTCDate() < anniversaryDay ? months - 1 : months;
}

export interface DepreciationInput {
  cost: number;
  salvageValue: number;
  usefulLifeMonths: number;
  acquiredOn: string;
}

export interface DepreciationState {
  /** Cost less salvage — the total that will ever be charged. */
  depreciableAmount: number;
  /** Even monthly charge, floored so the total can never exceed the cost. */
  monthlyCharge: number;
  monthsDepreciated: number;
  accumulated: number;
  /** cost − accumulated. Never falls below salvage value. */
  netBookValue: number;
  fullyDepreciated: boolean;
}

/**
 * The asset's position on a given date.
 *
 * The last month absorbs the flooring remainder, so accumulated depreciation
 * lands exactly on the depreciable amount at end of life rather than a few
 * pesewas short.
 */
export function depreciationAt(asset: DepreciationInput, on: Date): DepreciationState {
  const depreciableAmount = Math.max(0, asset.cost - asset.salvageValue);
  const monthlyCharge = Math.floor(depreciableAmount / asset.usefulLifeMonths);

  const acquired = new Date(`${asset.acquiredOn}T00:00:00.000Z`);
  const elapsed = monthsElapsed(acquired, on);
  const monthsDepreciated = Math.min(elapsed, asset.usefulLifeMonths);

  const accumulated =
    monthsDepreciated >= asset.usefulLifeMonths
      ? depreciableAmount // final month soaks up the rounding remainder
      : monthlyCharge * monthsDepreciated;

  return {
    depreciableAmount,
    monthlyCharge,
    monthsDepreciated,
    accumulated,
    netBookValue: asset.cost - accumulated,
    fullyDepreciated: monthsDepreciated >= asset.usefulLifeMonths,
  };
}

/**
 * Depreciation charged BETWEEN two dates — the expense belonging to a period,
 * which is the figure a profit and loss statement needs.
 *
 * Taken as the difference between the accumulated totals at each end, so it
 * inherits the final-month remainder handling above and a full life's periods
 * always sum to exactly the depreciable amount.
 */
export function depreciationForPeriod(asset: DepreciationInput, from: Date, to: Date): number {
  const start = depreciationAt(asset, from).accumulated;
  const end = depreciationAt(asset, to).accumulated;
  return Math.max(0, end - start);
}
