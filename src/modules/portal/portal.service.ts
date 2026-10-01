import { Types } from 'mongoose';
import { AppError } from '../../lib/errors.js';
import {
  HpAgreementModel,
  LoanModel,
  SavingsAccountModel,
  SusuAccountModel,
  SusuPlanModel,
} from '../../models/index.js';
import { NOT_TRASHED } from '../../models/shared.js';
import { availableToWithdraw, MIN_BALANCE, WITHDRAWAL_FEE } from '../../domain/savings.js';
import {
  lockedAmount,
  maxWithdrawal,
  SUSU_CYCLE_PAYMENTS,
  type PlanState,
} from '../../domain/susu-plans.js';
import { remainingOn } from '../hire-purchase/hp.service.js';

/**
 * What a customer sees about their own money.
 *
 * Every query here is pinned to the customer id taken from the portal token —
 * never from a request parameter — so there is no path by which one customer
 * reads another's records.
 *
 * Amounts are integer pesewas, as everywhere else.
 */

export interface PortalSusuPlan {
  planId: string;
  dailyAmount: number;
  /** Payments made in the cycle in progress, 0..30. */
  paidInCycle: number;
  cycleLength: number;
  cycleNumber: number;
  status: string;
}

export interface PortalSusuAccount {
  accountId: string;
  /** The customer's susu number — one per customer, for life. */
  accountNumber: string;
  status: string;
  balance: number;
  /** One payment per plan with a cycle in progress — the part nothing may take. */
  locked: number;
  /** Most the customer could take while keeping the account open. */
  availableToWithdraw: number;
  /** Σ daily amounts of the active plans. */
  dailyTotal: number;
  plans: PortalSusuPlan[];
}

export interface PortalSavingsAccount {
  accountId: string;
  accountNumber: string;
  accountType: string;
  status: string;
  balance: number;
  /** balance − the GHS 10 minimum − the GHS 10 fee. Never negative. */
  available: number;
  minBalance: number;
  withdrawalFee: number;
}

export interface PortalLoan {
  loanId: string;
  accountNumber?: string;
  tier: string;
  status: string;
  principal: number;
  ratePercent: number;
  totalDue: number;
  totalRepaid: number;
  remaining: number;
  durationMonths: number;
  dueDate: Date | null;
}

export interface PortalHpAgreement {
  agreementId: string;
  accountNumber?: string;
  itemName: string;
  status: string;
  totalPayable: number | null;
  totalPaid: number;
  remaining: number;
  durationMonths: number;
}

export interface PortalAccounts {
  susu: PortalSusuAccount[];
  savings: PortalSavingsAccount[];
  loans: PortalLoan[];
  hirePurchase: PortalHpAgreement[];
  totals: {
    /** Money the business is holding for this customer. */
    saved: number;
    /** Money this customer still owes. */
    owed: number;
  };
}

/**
 * Every product the customer holds, with the figures a handset screen needs
 * already derived — a portal client should never have to know that available
 * balance is `balance − 5000 − 1000`, or that one susu day stays reserved.
 *
 * Closed and settled records are included so history stays visible; the
 * `status` on each row is what the UI filters on.
 */
export async function myAccounts(customerIdHex: string): Promise<PortalAccounts> {
  const customerId = new Types.ObjectId(customerIdHex);

  const [susuAccounts, savingsAccounts, loans, agreements] = await Promise.all([
    SusuAccountModel.find({ customerId, ...NOT_TRASHED }).sort({ createdAt: -1 }),
    SavingsAccountModel.find({ customerId, ...NOT_TRASHED }).sort({ createdAt: -1 }),
    LoanModel.find({ customerId, ...NOT_TRASHED }).sort({ createdAt: -1 }),
    HpAgreementModel.find({ customerId, ...NOT_TRASHED }).sort({ createdAt: -1 }),
  ]);

  const plans = await SusuPlanModel.find({
    accountId: { $in: susuAccounts.map((a) => a._id) },
  }).sort({ createdAt: 1 });
  const susu: PortalSusuAccount[] = susuAccounts.map((a) => {
    const mine = plans.filter((p) => p.accountId.equals(a._id));
    const states: PlanState[] = mine.map((p) => ({
      planId: p._id.toHexString(),
      dailyAmount: p.dailyAmount,
      paidInCycle: p.paidInCycle,
      cyclesCompleted: p.cyclesCompleted,
      status: p.status,
    }));
    const open = a.status === 'active';
    return {
      accountId: a._id.toHexString(),
      accountNumber: a.accountNumber,
      status: a.status,
      balance: a.balance,
      locked: open ? lockedAmount(states) : 0,
      availableToWithdraw: open ? maxWithdrawal(a.balance, states) : 0,
      dailyTotal: mine.reduce((sum, p) => (p.status === 'active' ? sum + p.dailyAmount : sum), 0),
      plans: mine.map((p) => ({
        planId: p._id.toHexString(),
        dailyAmount: p.dailyAmount,
        paidInCycle: p.paidInCycle,
        cycleLength: SUSU_CYCLE_PAYMENTS,
        cycleNumber: p.cyclesCompleted + 1,
        status: p.status,
      })),
    };
  });

  const savings: PortalSavingsAccount[] = savingsAccounts.map((a) => ({
    accountId: a._id.toHexString(),
    accountNumber: a.accountNumber,
    accountType: a.accountType,
    status: a.status,
    balance: a.balance,
    available: availableToWithdraw(a.balance),
    minBalance: MIN_BALANCE,
    withdrawalFee: WITHDRAWAL_FEE,
  }));

  const portalLoans: PortalLoan[] = loans.map((l) => ({
    loanId: l._id.toHexString(),
    ...(l.accountNumber !== undefined ? { accountNumber: l.accountNumber } : {}),
    tier: l.tier,
    status: l.status,
    principal: l.principal,
    ratePercent: l.ratePercent,
    totalDue: l.totalDue,
    totalRepaid: l.totalRepaid,
    remaining: l.totalDue - l.totalRepaid,
    durationMonths: l.durationMonths,
    dueDate: l.dueDate ?? null,
  }));

  const hirePurchase: PortalHpAgreement[] = agreements.map((a) => ({
    agreementId: a._id.toHexString(),
    ...(a.accountNumber !== undefined ? { accountNumber: a.accountNumber } : {}),
    itemName: a.itemSnapshot.name,
    status: a.status,
    totalPayable: a.totalPayable ?? null,
    totalPaid: a.totalPaid,
    remaining: remainingOn(a),
    durationMonths: a.durationMonths,
  }));

  // Only OPEN products count toward the headline figures — a closed susu
  // cycle or a repaid loan is history, not a current position.
  const saved =
    susu.filter((a) => a.status === 'active').reduce((sum, a) => sum + a.balance, 0) +
    savings.filter((a) => a.status === 'active').reduce((sum, a) => sum + a.balance, 0);
  const owed =
    portalLoans
      .filter((l) => l.status === 'active' || l.status === 'arrears')
      .reduce((sum, l) => sum + l.remaining, 0) +
    hirePurchase
      .filter((a) => a.status === 'active' || a.status === 'in-arrears')
      .reduce((sum, a) => sum + a.remaining, 0);

  return { susu, savings, loans: portalLoans, hirePurchase, totals: { saved, owed } };
}

/**
 * Confirms a susu or savings account belongs to this customer, returning it.
 *
 * 404 rather than 403 on someone else's account: the portal must not confirm
 * that an account id exists at all to a customer who does not own it.
 */
export async function assertOwnedSusu(
  customerIdHex: string,
  accountId: Types.ObjectId,
): Promise<Awaited<ReturnType<typeof SusuAccountModel.findOne>>> {
  const account = await SusuAccountModel.findOne({
    _id: accountId,
    customerId: new Types.ObjectId(customerIdHex),
    ...NOT_TRASHED,
  });
  if (!account) throw new AppError('NOT_FOUND', 'Susu account not found', 404);
  return account;
}

export async function assertOwnedSavings(
  customerIdHex: string,
  accountId: Types.ObjectId,
): Promise<Awaited<ReturnType<typeof SavingsAccountModel.findOne>>> {
  const account = await SavingsAccountModel.findOne({
    _id: accountId,
    customerId: new Types.ObjectId(customerIdHex),
    ...NOT_TRASHED,
  });
  if (!account) throw new AppError('NOT_FOUND', 'Savings account not found', 404);
  return account;
}
