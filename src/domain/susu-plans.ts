/**
 * Susu money rules for the one-account model (client decision, 30 Sep 2026).
 *
 * A customer holds ONE susu account with ONE balance, like savings. Inside it
 * run one or more plans, each a fixed daily amount on its own cycle of 31
 * payments. A cycle counts payments, never dates: a deposit of 5 × the daily
 * amount is 5 of 31, and a cycle that takes three months is still one cycle.
 *
 * Commission is one payment of the plan's amount per cycle. It is taken
 * automatically the moment the 31st payment lands; until then one payment's
 * amount per plan stays locked in the balance so it is always covered, and
 * stopping a plan (or closing the account) mid-cycle charges it on the spot.
 *
 * Everything is integer pesewas. Business-rule violations throw RangeError
 * with a message fit for staff; malformed input throws Error.
 */

export const SUSU_CYCLE_PAYMENTS = 31;
/** Minimum daily amount when a plan is started or its amount changed — GHS 10. */
export const SUSU_MIN_DAILY_AMOUNT = 1000;
/**
 * How many cycles one deposit may touch on one plan.
 *
 * Two: the real case is a catch-up that overshoots day 31 by a few payments.
 * A deposit spanning more than that is far likelier a typo at the counter —
 * 6200000 keyed for 62000 — than cash somebody handed over, and quietly
 * completing three cycles (and charging three commissions) on a typo is worse
 * than refusing and asking.
 */
export const SUSU_MAX_CYCLES_PER_DEPOSIT = 2;

function assertMoneyInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer (pesewas), got ${String(value)}`);
  }
}

function assertCount(value: number, name: string, max = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`${name} out of range: ${String(value)}`);
  }
}

/** The rule-relevant slice of a plan. */
export interface PlanState {
  planId: string;
  dailyAmount: number;
  /**
   * Payments made in the current cycle, 0..30. Never 31 at rest: the 31st
   * payment completes the cycle, takes the commission and resets this to 0.
   * Zero means the plan is between cycles — nothing is owed and nothing locked.
   */
  paidInCycle: number;
  cyclesCompleted: number;
  status: 'active' | 'stopped';
}

function assertPlan(plan: PlanState): void {
  assertMoneyInt(plan.dailyAmount, 'dailyAmount');
  if (plan.dailyAmount < 1) throw new Error('dailyAmount must be at least 1 pesewa');
  assertCount(plan.paidInCycle, 'paidInCycle', SUSU_CYCLE_PAYMENTS - 1);
  assertCount(plan.cyclesCompleted, 'cyclesCompleted');
}

/** A cycle in progress owes its commission; one between cycles owes nothing. */
export function isMidCycle(plan: PlanState): boolean {
  assertPlan(plan);
  return plan.status === 'active' && plan.paidInCycle > 0;
}

/**
 * The part of the balance nothing may take out: one payment's amount for
 * every plan with a cycle in progress. This is what keeps the end-of-cycle
 * commission collectible however much is withdrawn along the way.
 */
export function lockedAmount(plans: readonly PlanState[]): number {
  return plans.reduce((sum, p) => (isMidCycle(p) ? sum + p.dailyAmount : sum), 0);
}

/**
 * The most that may leave the account while it stays open — by withdrawal,
 * transfer, or loan/HP repayment alike.
 */
export function maxWithdrawal(balance: number, plans: readonly PlanState[]): number {
  assertMoneyInt(balance, 'balance');
  return Math.max(0, balance - lockedAmount(plans));
}

export interface WithdrawalComputation {
  balanceAfter: number;
  /** Still locked against commissions not yet taken. */
  locked: number;
}

/** Money out, nothing else: no commission, and every cycle is untouched. */
export function computeWithdrawal(
  balance: number,
  plans: readonly PlanState[],
  amount: number,
): WithdrawalComputation {
  assertMoneyInt(balance, 'balance');
  assertMoneyInt(amount, 'amount');
  if (amount < 1) throw new Error('amount must be at least 1 pesewa');
  const available = maxWithdrawal(balance, plans);
  if (amount > available) {
    throw new RangeError(`amount exceeds the withdrawable balance (${String(available)})`);
  }
  return { balanceAfter: balance - amount, locked: lockedAmount(plans) };
}

export interface WithdrawalUnpay {
  /** Whole payments the withdrawal takes off the plan's cycle in progress. */
  payments: number;
  after: Pick<PlanState, 'paidInCycle' | 'cyclesCompleted'>;
}

/**
 * A withdrawal taken against a plan takes whole payments off its cycle in
 * progress — the mirror of a deposit, which puts them on (client decision,
 * 30 Sep 2026, superseding "cycles untouched"). Two limits: never past 0 of
 * 31, and never into a completed cycle, whose commission is already taken.
 * The part of the amount that is not a whole payment leaves the balance but
 * costs no day, the way a deposit's leftover buys none.
 */
export function computeWithdrawalUnpay(plan: PlanState, amount: number): WithdrawalUnpay {
  assertPlan(plan);
  assertMoneyInt(amount, 'amount');
  const untouched = { paidInCycle: plan.paidInCycle, cyclesCompleted: plan.cyclesCompleted };
  if (plan.status !== 'active') return { payments: 0, after: untouched };
  const payments = Math.min(plan.paidInCycle, Math.floor(amount / plan.dailyAmount));
  return {
    payments,
    after: { paidInCycle: plan.paidInCycle - payments, cyclesCompleted: plan.cyclesCompleted },
  };
}

/** A plan with what it holds: its share of the account's balance, pesewas. */
export interface PlanMoneyState extends PlanState {
  balance: number;
}

/** One plan's share of a withdrawal. */
export interface WithdrawalLine {
  planId: string;
  /** The plan's amount at the time, so the days it cost can be read back later. */
  dailyAmount: number;
  amount: number;
  /** Whole payments this share took off the plan's cycle in progress. */
  payments: number;
  after: Pick<PlanState, 'paidInCycle' | 'cyclesCompleted'>;
}

export interface WithdrawalAllocation {
  lines: WithdrawalLine[];
  /** What no plan could give: money in the account that sits on no plan. */
  loose: number;
}

/**
 * Spread a withdrawal over the plans, in the order given: each plan gives up
 * to what it holds less its own lock (one payment while it is mid-cycle), and
 * what it cannot cover moves on to the next. Whatever is left after every
 * plan comes from the account's loose money — deposit remainders and the
 * like — which the caller has already checked is there via the account-wide
 * lock rule. Each share takes whole payments off its plan's cycle in progress
 * by the unpay rule. The user asked for this on 30 Sep 2026: no picking a
 * plan at the counter, the money walks the plans and each one records its part.
 */
export function allocateWithdrawal(
  plans: readonly PlanMoneyState[],
  amount: number,
  /**
   * Whether each share takes days off its plan. Cash across the counter does;
   * a transfer or a loan repayment paid from susu records its share on the
   * plans but leaves their cycles where they were.
   */
  costsDays = true,
): WithdrawalAllocation {
  assertMoneyInt(amount, 'amount');
  if (amount < 1) throw new Error('amount must be at least 1 pesewa');
  const lines: WithdrawalLine[] = [];
  let remaining = amount;
  for (const plan of plans) {
    if (remaining === 0) break;
    assertPlan(plan);
    assertMoneyInt(plan.balance, 'balance');
    const lock = isMidCycle(plan) ? plan.dailyAmount : 0;
    const give = Math.min(remaining, Math.max(0, plan.balance - lock));
    if (give === 0) continue;
    const unpay = costsDays
      ? computeWithdrawalUnpay(plan, give)
      : {
          payments: 0,
          after: { paidInCycle: plan.paidInCycle, cyclesCompleted: plan.cyclesCompleted },
        };
    lines.push({
      planId: plan.planId,
      dailyAmount: plan.dailyAmount,
      amount: give,
      payments: unpay.payments,
      after: unpay.after,
    });
    remaining -= give;
  }
  return { lines, loose: remaining };
}

/** One stretch of a deposit inside one cycle of one plan. */
export interface CycleChunk {
  /** 1-based: the plan's first cycle is 1. */
  cycleNumber: number;
  payments: number;
  /** 1-based positions within that cycle, 1..31. */
  seqStart: number;
  seqEnd: number;
  completesCycle: boolean;
}

export interface PlanPaymentResult {
  chunks: CycleChunk[];
  /** One entry per cycle this deposit completed, each one payment's amount. */
  commissions: { cycleNumber: number; amount: number }[];
  after: Pick<PlanState, 'paidInCycle' | 'cyclesCompleted'>;
}

/**
 * Credit `payments` to one plan, rolling over at 31.
 *
 * At 29 of 31, five payments split [2, 3]: the first two finish the cycle and
 * take its commission, the other three open the next cycle at the same daily
 * amount. The chunks always sum to `payments`.
 */
export function applyPlanPayments(plan: PlanState, payments: number): PlanPaymentResult {
  assertPlan(plan);
  if (!Number.isInteger(payments) || payments < 1) {
    throw new Error(`payments must be a positive integer, got ${String(payments)}`);
  }
  if (plan.status !== 'active') {
    throw new RangeError('this plan is stopped — payments cannot be recorded against it');
  }

  const chunks: CycleChunk[] = [];
  const commissions: PlanPaymentResult['commissions'] = [];
  let paid = plan.paidInCycle;
  let completed = plan.cyclesCompleted;
  let left = payments;

  while (left > 0) {
    const take = Math.min(left, SUSU_CYCLE_PAYMENTS - paid);
    const cycleNumber = completed + 1;
    const seqStart = paid + 1;
    const seqEnd = paid + take;
    const completesCycle = seqEnd === SUSU_CYCLE_PAYMENTS;
    chunks.push({ cycleNumber, payments: take, seqStart, seqEnd, completesCycle });
    if (completesCycle) {
      commissions.push({ cycleNumber, amount: plan.dailyAmount });
      completed += 1;
      paid = 0;
    } else {
      paid = seqEnd;
    }
    left -= take;
  }

  if (chunks.length > SUSU_MAX_CYCLES_PER_DEPOSIT) {
    const most =
      SUSU_CYCLE_PAYMENTS -
      plan.paidInCycle +
      SUSU_CYCLE_PAYMENTS * (SUSU_MAX_CYCLES_PER_DEPOSIT - 1);
    throw new RangeError(
      `${String(payments)} payments is too many for one deposit on this plan — at most ${String(most)} can be recorded at once`,
    );
  }

  return { chunks, commissions, after: { paidInCycle: paid, cyclesCompleted: completed } };
}

/** Payments per plan, as staff enter them on the deposit form. */
export interface PlanSplit {
  planId: string;
  payments: number;
}

/** What the deposit form pre-fills: one payment on every active plan. */
export function defaultSplit(plans: readonly PlanState[]): PlanSplit[] {
  return plans.filter((p) => p.status === 'active').map((p) => ({ planId: p.planId, payments: 1 }));
}

export interface DepositAllocation {
  plans: (PlanPaymentResult & { planId: string; payments: number; amount: number })[];
  /** Paid toward plans: Σ payments × dailyAmount. */
  coveredAmount: number;
  /** Cash beyond whole payments — stays in the balance, counts toward no plan. */
  leftover: number;
  /** Commission taken by this deposit (cycles it completed). */
  commissionTotal: number;
  /** amount − commissionTotal: what the balance actually moves by. */
  balanceDelta: number;
}

/**
 * Split one deposit across the account's plans.
 *
 * Staff choose the payments per plan (defaulting to one each); whatever the
 * cash does not use in whole payments stays in the balance as leftover. A
 * deposit must pay at least one payment — money with no plan behind it would
 * be free storage with no commission ever due on it.
 */
export function allocateDeposit(
  amount: number,
  plans: readonly PlanState[],
  split: readonly PlanSplit[],
): DepositAllocation {
  assertMoneyInt(amount, 'amount');
  if (amount < 1) throw new Error('amount must be at least 1 pesewa');

  const byId = new Map(plans.map((p) => [p.planId, p]));
  const seen = new Set<string>();
  const lines: DepositAllocation['plans'] = [];
  let coveredAmount = 0;

  for (const s of split) {
    if (seen.has(s.planId)) throw new RangeError('a plan appears twice in the split');
    seen.add(s.planId);
    if (!Number.isInteger(s.payments) || s.payments < 0) {
      throw new RangeError('payments per plan must be a whole number, zero or more');
    }
    if (s.payments === 0) continue;
    const plan = byId.get(s.planId);
    if (!plan) throw new RangeError('the split names a plan that is not on this account');
    const result = applyPlanPayments(plan, s.payments);
    const lineAmount = plan.dailyAmount * s.payments;
    coveredAmount += lineAmount;
    lines.push({ ...result, planId: s.planId, payments: s.payments, amount: lineAmount });
  }

  if (lines.length === 0) {
    throw new RangeError('a deposit must pay at least one payment toward a plan');
  }
  if (coveredAmount > amount) {
    throw new RangeError(
      `the split needs ${String(coveredAmount)} but the deposit is only ${String(amount)}`,
    );
  }

  const commissionTotal = lines.reduce(
    (sum, l) => sum + l.commissions.reduce((s, c) => s + c.amount, 0),
    0,
  );
  return {
    plans: lines,
    coveredAmount,
    leftover: amount - coveredAmount,
    commissionTotal,
    balanceDelta: amount - commissionTotal,
  };
}

/**
 * A plan's amount may change only between cycles. Mid-cycle it would muddle
 * both the count and the commission; the answer there is to stop the plan
 * (charging its one payment) and start a new one.
 */
export function canChangeAmount(plan: PlanState): boolean {
  assertPlan(plan);
  return plan.status === 'active' && plan.paidInCycle === 0;
}

export interface StopComputation {
  /** One payment's amount when stopped mid-cycle; zero between cycles. */
  commission: number;
  /** The unfinished cycle's number and count, when there was one. */
  endedCycle?: { cycleNumber: number; payments: number };
}

/**
 * Stopping a plan mid-cycle charges its one payment immediately — however
 * early (client rule, reaffirmed 30 Sep 2026). The rest of the money stays in
 * the balance: stopping a plan moves nothing out of the account.
 */
export function computeStopPlan(plan: PlanState): StopComputation {
  assertPlan(plan);
  if (plan.status !== 'active') throw new RangeError('this plan is already stopped');
  if (plan.paidInCycle === 0) return { commission: 0 };
  return {
    commission: plan.dailyAmount,
    endedCycle: { cycleNumber: plan.cyclesCompleted + 1, payments: plan.paidInCycle },
  };
}

export interface CloseComputation {
  commission: number;
  payout: number;
  /** Per plan stopped mid-cycle by the closure. */
  stops: (StopComputation & { planId: string })[];
}

/**
 * Closing the account: every plan mid-cycle is stopped and charged, and the
 * rest of the balance is paid out. The lock guarantees the balance covers the
 * commissions; if it somehow does not, the data is wrong and nothing moves.
 */
export function computeClose(balance: number, plans: readonly PlanState[]): CloseComputation {
  assertMoneyInt(balance, 'balance');
  const stops = plans
    .filter((p) => p.status === 'active')
    .map((p) => ({ ...computeStopPlan(p), planId: p.planId }));
  const commission = stops.reduce((sum, s) => sum + s.commission, 0);
  if (commission > balance) {
    throw new Error(
      `balance ${String(balance)} does not cover the locked commission ${String(commission)} — the lock was bypassed`,
    );
  }
  return { commission, payout: balance - commission, stops };
}
