import { accountRef } from '../../lib/account-number.js';
import { Types } from 'mongoose';
import { AppError } from '../../lib/errors.js';
import {
  HpAgreementModel,
  LoanModel,
  SavingsAccountModel,
  SusuAccountModel,
} from '../../models/index.js';
import { NOT_TRASHED } from '../../models/shared.js';
import { availableToWithdraw, MIN_BALANCE, WITHDRAWAL_FEE } from '../../domain/savings.js';
import {
  computeClosure,
  maxPartialWithdrawal,
  remainingDeposits,
  susuBalance,
  SUSU_CYCLE_DEPOSITS,
} from '../../domain/susu.js';
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

export interface PortalSusuAccount {
  accountId: string;
  /**
   * The customer's own susu number. Every book they hold carries it, so two
   * cycles in one month read identically — see `cycleMonth` and `ref`.
   */
  accountNumber: string;
  /** The month this book is called: what separates one cycle from the next. */
  cycleMonth?: string;
  /**
   * The book's own identity, rendered: `260912134501-a3f9`. The handset lists
   * cycles to pick between — including for closure, which cannot be undone —
   * so it needs something that always differs.
   */
  ref: string;
  status: string;
  dailyAmount: number;
  depositsCount: number;
  cycleLength: number;
  daysRemaining: number;
  totalDeposited: number;
  withdrawnAmount: number;
  balance: number;
  /**
   * Most the customer could take while keeping the account open — one day's
   * deposit stays reserved so the closing commission is always collectable.
   */
  maxPartialWithdrawal: number;
  /** What closing the cycle today would pay out, after commission. */
  closurePreview: { commission: number; payout: number };
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

  const susu: PortalSusuAccount[] = susuAccounts.map((a) => {
    const balance = susuBalance(a.totalDeposited, a.withdrawnAmount);
    const closure = computeClosure(balance, a.dailyAmount);
    return {
      accountId: a._id.toHexString(),
      accountNumber: a.accountNumber,
      ...(a.cycleMonth !== undefined ? { cycleMonth: a.cycleMonth } : {}),
      ref: accountRef(a._id.toHexString(), a.createdAt),
      status: a.status,
      dailyAmount: a.dailyAmount,
      depositsCount: a.depositsCount,
      cycleLength: SUSU_CYCLE_DEPOSITS,
      daysRemaining: remainingDeposits(a.depositsCount),
      totalDeposited: a.totalDeposited,
      withdrawnAmount: a.withdrawnAmount,
      balance,
      maxPartialWithdrawal: maxPartialWithdrawal(balance, a.dailyAmount),
      closurePreview: { commission: closure.commission, payout: closure.payout },
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
    susu
      .filter((a) => a.status === 'active' || a.status === 'completed')
      .reduce((sum, a) => sum + a.balance, 0) +
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
