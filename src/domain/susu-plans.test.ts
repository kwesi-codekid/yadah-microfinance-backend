import { describe, expect, it } from 'vitest';
import {
  SUSU_CYCLE_PAYMENTS,
  SUSU_MIN_DAILY_AMOUNT,
  allocateDeposit,
  allocateWithdrawal,
  applyPlanPayments,
  canChangeAmount,
  computeClose,
  computeStopPlan,
  computeWithdrawal,
  computeWithdrawalUnpay,
  defaultSplit,
  isMidCycle,
  lockedAmount,
  maxWithdrawal,
  type PlanState,
} from './susu-plans.js';

function plan(overrides: Partial<PlanState> = {}): PlanState {
  return {
    planId: 'a',
    dailyAmount: 1000,
    paidInCycle: 0,
    cyclesCompleted: 0,
    status: 'active',
    ...overrides,
  };
}

const A = plan({ planId: 'a', dailyAmount: 1000, paidInCycle: 12 }); // GHS 10, 12 of 31
const B = plan({ planId: 'b', dailyAmount: 2000, paidInCycle: 3 }); // GHS 20, 3 of 31

describe('constants', () => {
  it('a cycle is 31 payments; minimum daily amount is GHS 10', () => {
    expect(SUSU_CYCLE_PAYMENTS).toBe(31);
    expect(SUSU_MIN_DAILY_AMOUNT).toBe(1000);
  });
});

describe('lockedAmount — one payment per plan with a cycle in progress', () => {
  it('sums the daily amount of every mid-cycle plan', () => {
    expect(lockedAmount([A, B])).toBe(3000);
  });

  it('locks nothing for a plan between cycles', () => {
    expect(lockedAmount([A, plan({ planId: 'b', dailyAmount: 2000, paidInCycle: 0 })])).toBe(1000);
    expect(isMidCycle(plan({ paidInCycle: 0 }))).toBe(false);
  });

  it('locks nothing for a stopped plan', () => {
    expect(lockedAmount([A, { ...B, status: 'stopped' }])).toBe(1000);
  });

  it('is zero with no plans', () => {
    expect(lockedAmount([])).toBe(0);
  });
});

describe('maxWithdrawal / computeWithdrawal', () => {
  it('everything above the lock is withdrawable', () => {
    expect(maxWithdrawal(50000, [A, B])).toBe(47000);
  });

  it('never goes negative', () => {
    expect(maxWithdrawal(2000, [A, B])).toBe(0);
  });

  it('the whole balance is withdrawable when every plan is between cycles', () => {
    expect(maxWithdrawal(50000, [plan()])).toBe(50000);
  });

  it('allows exactly the maximum and leaves the lock behind', () => {
    const r = computeWithdrawal(50000, [A, B], 47000);
    expect(r.balanceAfter).toBe(3000);
    expect(r.locked).toBe(3000);
  });

  it('refuses one pesewa into the lock', () => {
    expect(() => computeWithdrawal(50000, [A, B], 47001)).toThrow(RangeError);
  });

  it('rejects zero and non-integer amounts', () => {
    expect(() => computeWithdrawal(50000, [A], 0)).toThrow();
    expect(() => computeWithdrawal(50000, [A], 10.5)).toThrow();
  });
});

describe('computeWithdrawalUnpay — a withdrawal against a plan takes days off its cycle', () => {
  it('removes whole payments, the remainder costing no day', () => {
    // GHS 15 off a GHS 10 plan at 12 of 31: one payment, GHS 5 untracked.
    const r = computeWithdrawalUnpay(A, 1500);
    expect(r).toEqual({ payments: 1, after: { paidInCycle: 11, cyclesCompleted: 0 } });
  });

  it('stops at 0 of 31 and never enters a completed cycle', () => {
    const r = computeWithdrawalUnpay(plan({ paidInCycle: 5, cyclesCompleted: 2 }), 20_000);
    expect(r).toEqual({ payments: 5, after: { paidInCycle: 0, cyclesCompleted: 2 } });
  });

  it('less than one payment takes nothing off', () => {
    expect(computeWithdrawalUnpay(A, 999).payments).toBe(0);
  });

  it('a stopped plan is untouched', () => {
    const stopped = plan({ status: 'stopped', paidInCycle: 4 });
    expect(computeWithdrawalUnpay(stopped, 4000)).toEqual({
      payments: 0,
      after: { paidInCycle: 4, cyclesCompleted: 0 },
    });
  });
});

describe('allocateWithdrawal — the money walks the plans', () => {
  // A: GHS 10 a day, 12 of 31, holds GHS 120. B: GHS 20 a day, 3 of 31, holds GHS 60.
  const a = { ...A, balance: 12_000 };
  const b = { ...B, balance: 6_000 };

  it('takes from the first plan while it can, then moves on', () => {
    // A can give 110 (120 less its GHS 10 lock); the rest comes off B.
    const r = allocateWithdrawal([a, b], 13_000);
    expect(r.lines).toEqual([
      {
        planId: 'a',
        dailyAmount: 1000,
        amount: 11_000,
        payments: 11,
        after: { paidInCycle: 1, cyclesCompleted: 0 },
      },
      {
        planId: 'b',
        dailyAmount: 2000,
        amount: 2_000,
        payments: 1,
        after: { paidInCycle: 2, cyclesCompleted: 0 },
      },
    ]);
    expect(r.loose).toBe(0);
  });

  it('a small amount touches only the first plan', () => {
    const r = allocateWithdrawal([a, b], 1_500);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ planId: 'a', amount: 1_500, payments: 1 });
  });

  it('what no plan can give is loose money', () => {
    // A gives 110, B gives 40: 150 in all. The other 20 sits on no plan.
    const r = allocateWithdrawal([a, b], 17_000);
    expect(r.lines.map((l) => l.amount)).toEqual([11_000, 4_000]);
    expect(r.loose).toBe(2_000);
  });

  it('a plan holding nothing, or only its lock, is skipped', () => {
    const empty = { ...plan({ planId: 'e', paidInCycle: 1 }), balance: 1_000 };
    const r = allocateWithdrawal([empty, b], 2_000);
    expect(r.lines).toEqual([
      {
        planId: 'b',
        dailyAmount: 2000,
        amount: 2_000,
        payments: 1,
        after: { paidInCycle: 2, cyclesCompleted: 0 },
      },
    ]);
  });

  it('can record the shares without costing days, for transfers and loan repayments', () => {
    const r = allocateWithdrawal([a, b], 13_000, false);
    expect(r.lines.map((l) => [l.planId, l.amount, l.payments])).toEqual([
      ['a', 11_000, 0],
      ['b', 2_000, 0],
    ]);
    expect(r.lines[0]?.after).toEqual({ paidInCycle: 12, cyclesCompleted: 0 });
  });

  it('a stopped plan gives its money but no days', () => {
    const stopped = { ...plan({ planId: 's', status: 'stopped', paidInCycle: 0 }), balance: 5_000 };
    const r = allocateWithdrawal([stopped], 3_000);
    expect(r.lines).toEqual([
      {
        planId: 's',
        dailyAmount: 1000,
        amount: 3_000,
        payments: 0,
        after: { paidInCycle: 0, cyclesCompleted: 0 },
      },
    ]);
  });
});

describe('applyPlanPayments — counted by payments, rolling at 31', () => {
  it('ordinary payment moves the count', () => {
    const r = applyPlanPayments(A, 1);
    expect(r.chunks).toEqual([
      { cycleNumber: 1, payments: 1, seqStart: 13, seqEnd: 13, completesCycle: false },
    ]);
    expect(r.commissions).toEqual([]);
    expect(r.after).toEqual({ paidInCycle: 13, cyclesCompleted: 0 });
  });

  it('a catch-up counts by amount: 5 payments is 5 of 31', () => {
    const r = applyPlanPayments(plan(), 5);
    expect(r.chunks[0]).toMatchObject({ seqStart: 1, seqEnd: 5, payments: 5 });
    expect(r.after.paidInCycle).toBe(5);
  });

  it('the 31st payment completes the cycle and takes one payment as commission', () => {
    const r = applyPlanPayments(plan({ paidInCycle: 30 }), 1);
    expect(r.chunks).toEqual([
      { cycleNumber: 1, payments: 1, seqStart: 31, seqEnd: 31, completesCycle: true },
    ]);
    expect(r.commissions).toEqual([{ cycleNumber: 1, amount: 1000 }]);
    expect(r.after).toEqual({ paidInCycle: 0, cyclesCompleted: 1 });
  });

  it('overflow: at 29, five payments finish the cycle and start the next at the same amount', () => {
    const r = applyPlanPayments(plan({ paidInCycle: 29, cyclesCompleted: 2 }), 5);
    expect(r.chunks).toEqual([
      { cycleNumber: 3, payments: 2, seqStart: 30, seqEnd: 31, completesCycle: true },
      { cycleNumber: 4, payments: 3, seqStart: 1, seqEnd: 3, completesCycle: false },
    ]);
    expect(r.commissions).toEqual([{ cycleNumber: 3, amount: 1000 }]);
    expect(r.after).toEqual({ paidInCycle: 3, cyclesCompleted: 3 });
  });

  it('a whole cycle in one go from zero', () => {
    const r = applyPlanPayments(plan(), 31);
    expect(r.chunks).toHaveLength(1);
    expect(r.commissions).toHaveLength(1);
    expect(r.after).toEqual({ paidInCycle: 0, cyclesCompleted: 1 });
  });

  it('two whole cycles from zero complete both and charge twice', () => {
    const r = applyPlanPayments(plan(), 62);
    expect(r.commissions.map((c) => c.cycleNumber)).toEqual([1, 2]);
    expect(r.after).toEqual({ paidInCycle: 0, cyclesCompleted: 2 });
  });

  it('refuses a deposit spanning a third cycle (likely a typo)', () => {
    expect(() => applyPlanPayments(plan({ paidInCycle: 29 }), 34)).toThrow(RangeError);
    expect(() => applyPlanPayments(plan({ paidInCycle: 29 }), 33)).not.toThrow();
    expect(() => applyPlanPayments(plan(), 63)).toThrow(/at most 62/);
  });

  it('chunks always sum to the payments', () => {
    for (let paid = 0; paid < 31; paid += 1) {
      for (const n of [1, 2, 15, 31]) {
        const r = applyPlanPayments(plan({ paidInCycle: paid }), n);
        expect(r.chunks.reduce((s, c) => s + c.payments, 0)).toBe(n);
      }
    }
  });

  it('refuses a stopped plan', () => {
    expect(() => applyPlanPayments(plan({ status: 'stopped' }), 1)).toThrow(RangeError);
  });

  it('rejects bad input', () => {
    expect(() => applyPlanPayments(plan(), 0)).toThrow();
    expect(() => applyPlanPayments(plan(), 1.5)).toThrow();
    expect(() => applyPlanPayments(plan({ paidInCycle: 31 }), 1)).toThrow();
    expect(() => applyPlanPayments(plan({ dailyAmount: 10.5 }), 1)).toThrow();
  });
});

describe('allocateDeposit — one deposit across the plans', () => {
  it('the default pre-fills one payment on every active plan', () => {
    expect(defaultSplit([A, B, plan({ planId: 'c', status: 'stopped' })])).toEqual([
      { planId: 'a', payments: 1 },
      { planId: 'b', payments: 1 },
    ]);
  });

  it('exact total: one payment each, no leftover', () => {
    const r = allocateDeposit(3000, [A, B], defaultSplit([A, B]));
    expect(r.coveredAmount).toBe(3000);
    expect(r.leftover).toBe(0);
    expect(r.commissionTotal).toBe(0);
    expect(r.balanceDelta).toBe(3000);
  });

  it('staff split GHS 50 as 3 × GHS 10 + 1 × GHS 20', () => {
    const r = allocateDeposit(
      5000,
      [A, B],
      [
        { planId: 'a', payments: 3 },
        { planId: 'b', payments: 1 },
      ],
    );
    expect(r.plans.map((p) => [p.planId, p.amount])).toEqual([
      ['a', 3000],
      ['b', 2000],
    ]);
    expect(r.leftover).toBe(0);
  });

  it('leftover beyond whole payments stays in the balance', () => {
    const r = allocateDeposit(5500, [A, B], defaultSplit([A, B]));
    expect(r.coveredAmount).toBe(3000);
    expect(r.leftover).toBe(2500);
    expect(r.balanceDelta).toBe(5500);
  });

  it('a plan with zero payments is skipped', () => {
    const r = allocateDeposit(
      2000,
      [A, B],
      [
        { planId: 'a', payments: 0 },
        { planId: 'b', payments: 1 },
      ],
    );
    expect(r.plans.map((p) => p.planId)).toEqual(['b']);
  });

  it('completing a cycle takes its commission out of the deposit', () => {
    const nearlyDone = plan({ planId: 'a', dailyAmount: 1000, paidInCycle: 30 });
    const r = allocateDeposit(3000, [nearlyDone, B], defaultSplit([nearlyDone, B]));
    expect(r.commissionTotal).toBe(1000);
    expect(r.balanceDelta).toBe(2000);
  });

  it('refuses a split the cash cannot cover', () => {
    expect(() => allocateDeposit(2500, [A, B], defaultSplit([A, B]))).toThrow(RangeError);
  });

  it('refuses a deposit paying no plan at all', () => {
    expect(() => allocateDeposit(5000, [A], [{ planId: 'a', payments: 0 }])).toThrow(RangeError);
    expect(() => allocateDeposit(5000, [A], [])).toThrow(RangeError);
  });

  it('refuses unknown, duplicated and stopped plans', () => {
    expect(() => allocateDeposit(5000, [A], [{ planId: 'zzz', payments: 1 }])).toThrow(RangeError);
    expect(() =>
      allocateDeposit(
        5000,
        [A],
        [
          { planId: 'a', payments: 1 },
          { planId: 'a', payments: 1 },
        ],
      ),
    ).toThrow(RangeError);
    expect(() =>
      allocateDeposit(5000, [{ ...A, status: 'stopped' }], [{ planId: 'a', payments: 1 }]),
    ).toThrow(RangeError);
  });

  it('refuses negative or fractional payments', () => {
    expect(() => allocateDeposit(5000, [A], [{ planId: 'a', payments: -1 }])).toThrow(RangeError);
    expect(() => allocateDeposit(5000, [A], [{ planId: 'a', payments: 1.5 }])).toThrow(RangeError);
  });
});

describe('canChangeAmount — only between cycles', () => {
  it('allowed on a fresh plan or right after a cycle completes', () => {
    expect(canChangeAmount(plan())).toBe(true);
    expect(canChangeAmount(plan({ cyclesCompleted: 4 }))).toBe(true);
  });

  it('refused mid-cycle and on a stopped plan', () => {
    expect(canChangeAmount(plan({ paidInCycle: 1 }))).toBe(false);
    expect(canChangeAmount(plan({ status: 'stopped' }))).toBe(false);
  });
});

describe('computeStopPlan — mid-cycle stop charges one payment', () => {
  it('charges one payment however early', () => {
    expect(computeStopPlan(plan({ paidInCycle: 1, cyclesCompleted: 2 }))).toEqual({
      commission: 1000,
      endedCycle: { cycleNumber: 3, payments: 1 },
    });
  });

  it('charges nothing between cycles', () => {
    expect(computeStopPlan(plan({ cyclesCompleted: 3 }))).toEqual({ commission: 0 });
  });

  it('refuses a plan already stopped', () => {
    expect(() => computeStopPlan(plan({ status: 'stopped' }))).toThrow(RangeError);
  });
});

describe('computeClose — stop every plan, pay out the rest', () => {
  it('charges each mid-cycle plan once and pays out the remainder', () => {
    const r = computeClose(50000, [A, B, plan({ planId: 'c', paidInCycle: 0 })]);
    expect(r.commission).toBe(3000);
    expect(r.payout).toBe(47000);
    expect(r.stops.map((s) => [s.planId, s.commission])).toEqual([
      ['a', 1000],
      ['b', 2000],
      ['c', 0],
    ]);
  });

  it('ignores plans already stopped', () => {
    const r = computeClose(10000, [A, { ...B, status: 'stopped' }]);
    expect(r.commission).toBe(1000);
    expect(r.stops).toHaveLength(1);
  });

  it('pays out the whole balance when no cycle is in progress', () => {
    expect(computeClose(10000, [plan()]).payout).toBe(10000);
  });

  it('the payout plus commission always equals the balance', () => {
    const r = computeClose(3000, [A, B]);
    expect(r.payout + r.commission).toBe(3000);
    expect(r.payout).toBe(0);
  });

  it('fails loud when the balance is below the lock (data is wrong)', () => {
    expect(() => computeClose(2999, [A, B])).toThrow(Error);
  });
});
