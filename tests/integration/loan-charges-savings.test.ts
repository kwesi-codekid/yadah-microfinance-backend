import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accraDay } from '../../src/lib/time.js';
import { runLoanSavingsPass } from '../../src/lib/loan-savings.js';
import {
  LoanModel,
  LoanScheduleModel,
  RepaymentModel,
  SavingsAccountModel,
  SavingsTxnModel,
} from '../../src/models/index.js';
import * as loans from '../../src/modules/loans/loans.service.js';
import { recordPaperLoan } from '../../src/modules/loans/paper-loans.service.js';
import * as savings from '../../src/modules/savings/savings.service.js';
import { transfer } from '../../src/modules/transfers/transfers.service.js';
import { listTransactions } from '../../src/modules/reports/transactions.service.js';
import { commissionEarned } from '../../src/modules/reports/reports.service.js';
import { balanceSheet } from '../../src/modules/accounting/balance-sheet.service.js';
import {
  asOfficer,
  makeCustomer,
  makeGuarantor,
  makeTeller,
  setupDb,
  teardownDb,
} from './helpers.js';

/**
 * Client decisions of 6 Oct 2026: a processing fee and cash collateral on
 * every kind of loan, a repayment dated the day the customer paid, and a loan
 * savings account emptied into the loan at each month end.
 */

let guarantor: Types.ObjectId;
beforeAll(async () => {
  await setupDb();
  guarantor = await makeGuarantor();
});
afterAll(teardownDb);

const officer = asOfficer();

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

/** A GHS 1,000 loan over 3 months (due GHS 1,100), approved — out today. */
async function activeLoan(
  customerId: Types.ObjectId,
  charges: loans.LoanCharges = {},
): Promise<Types.ObjectId> {
  const applied = await loans.applyForLoan(
    officer,
    customerId,
    100_000,
    3,
    guarantor,
    undefined,
    undefined,
    charges,
  );
  const loanId = new Types.ObjectId(applied.id);
  await loans.approveLoan(officer, loanId);
  return loanId;
}

async function openLoanSavings(customerId: Types.ObjectId, deposit?: number) {
  const { account } = await savings.openAccount(
    officer,
    customerId,
    deposit,
    randomUUID(),
    'cash',
    'loan',
  );
  return new Types.ObjectId(account.id);
}

describe('processing fee and cash collateral', () => {
  it('are stored on a new loan, apart from what it owes', async () => {
    const customerId = await makeCustomer(true);
    const loanId = await activeLoan(customerId, {
      processingFee: 5_000,
      collateralAmount: 100_000,
    });
    const { loan } = await loans.getLoan(loanId);
    expect(loan).toMatchObject({
      processingFee: 5_000,
      collateralAmount: 100_000,
      totalDue: 110_000, // the fee is not part of the loan
    });
    expect(loan.collateralReturnedAt).toBeUndefined();
  });

  it('show in the cash book on the day the loan goes out, the fee as revenue', async () => {
    const customerId = await makeCustomer(true);
    const loanId = await activeLoan(customerId, { processingFee: 7_500, collateralAmount: 50_000 });
    const feed = await listTransactions({
      customerId,
      page: 1,
      limit: 50,
      includePending: false,
      format: 'json',
    } as never);
    const byType = new Map(feed.items.map((r) => [r.type, r]));
    expect(byType.get('loan-fee')).toMatchObject({ amount: 7_500, direction: 'in' });
    expect(byType.get('loan-collateral')).toMatchObject({ amount: 50_000, direction: 'in' });
    expect(byType.get('loan-disbursement')).toMatchObject({ amount: 100_000, direction: 'out' });
    // Three rows off one loan, each with its own id.
    expect(new Set(feed.items.map((r) => r.id)).size).toBe(feed.items.length);
    expect(feed.items.every((r) => r.ref.id === loanId.toHexString())).toBe(true);
    expect(feed.totals.feesCollected).toBe(7_500);

    const revenue = await commissionEarned(accraDay(), accraDay());
    expect(revenue.loanProcessingFees.amount).toBeGreaterThanOrEqual(7_500);
  });

  it('are refused nowhere when left out — zero is the same as none', async () => {
    const customerId = await makeCustomer(true);
    const loanId = await activeLoan(customerId, { processingFee: 0 });
    const { loan } = await loans.getLoan(loanId);
    expect(loan.processingFee).toBeUndefined();
    expect(loan.collateralAmount).toBeUndefined();
  });

  it('go on a paper loan too, dated when the money went out', async () => {
    const customerId = await makeCustomer();
    const loan = await recordPaperLoan(officer, {
      customerId,
      principal: 200_000,
      durationMonths: 3,
      ratePercent: 10,
      disbursedOn: daysAgo(30),
      guarantors: [],
      repayments: [],
      processingFee: 4_000,
      collateralAmount: 20_000,
    });
    expect(loan).toMatchObject({ processingFee: 4_000, collateralAmount: 20_000 });
    const revenue = await commissionEarned(daysAgo(30), daysAgo(30));
    expect(revenue.loanProcessingFees.amount).toBe(4_000);
  });

  it('holds the collateral as a liability until it is handed back', async () => {
    const customerId = await makeCustomer(true);
    const loanId = await activeLoan(customerId, { collateralAmount: 30_000 });
    const before = await balanceSheet();

    // Not while the loan is open.
    await expect(loans.returnCollateral(officer, loanId)).rejects.toMatchObject({
      code: 'LOAN_NOT_REPAID',
    });
    await loans.repayCash(officer, loanId, 110_000, randomUUID(), 'cash');
    const returned = await loans.returnCollateral(officer, loanId);
    expect(returned.collateralReturnedAt).toBeDefined();
    await expect(loans.returnCollateral(officer, loanId)).rejects.toMatchObject({
      code: 'COLLATERAL_RETURNED',
    });

    const after = await balanceSheet();
    expect(
      before.liabilities.customerDeposits.collateralHeld -
        after.liabilities.customerDeposits.collateralHeld,
    ).toBe(30_000);
    const feed = await listTransactions({
      customerId,
      page: 1,
      limit: 50,
      includePending: false,
      format: 'json',
    } as never);
    expect(feed.items.find((r) => r.type === 'loan-collateral-return')).toMatchObject({
      amount: 30_000,
      direction: 'out',
    });
  });
});

describe('a repayment on the day the customer paid', () => {
  it('lands on that day when the office names it', async () => {
    const customerId = await makeCustomer(true);
    const loanId = await activeLoan(customerId);
    // The loan went out today, so the earliest day it can be paid is today —
    // move it back to make room for a payment typed in late.
    await LoanModel.updateOne({ _id: loanId }, { $set: { disbursedAt: new Date(daysAgo(20)) } });
    const result = await loans.repayCash(
      officer,
      loanId,
      20_000,
      randomUUID(),
      'cash',
      undefined,
      daysAgo(4),
    );
    const repayment = await RepaymentModel.findById(result.repayment.id);
    expect(repayment?.createdAt.toISOString().slice(0, 10)).toBe(daysAgo(4));
  });

  it('is today when the date is left empty', async () => {
    const customerId = await makeCustomer(true);
    const loanId = await activeLoan(customerId);
    const result = await loans.repayCash(officer, loanId, 20_000, randomUUID(), 'cash');
    const repayment = await RepaymentModel.findById(result.repayment.id);
    expect(repayment?.createdAt.toISOString().slice(0, 10)).toBe(accraDay());
  });

  it('is refused from a teller, who records today', async () => {
    const customerId = await makeCustomer(true);
    const loanId = await activeLoan(customerId);
    const teller = await makeTeller();
    await expect(
      loans.repayCash(teller, loanId, 20_000, randomUUID(), 'cash', undefined, daysAgo(1)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('cannot be dated before the loan went out', async () => {
    const customerId = await makeCustomer(true);
    const loanId = await activeLoan(customerId);
    await expect(
      loans.repayCash(officer, loanId, 20_000, randomUUID(), 'cash', undefined, daysAgo(2)),
    ).rejects.toMatchObject({ code: 'DATE_BEFORE_LOAN' });
  });

  it('judges "repaid on time" by the day it was paid', async () => {
    const customerId = await makeCustomer(true);
    const loanId = await activeLoan(customerId);
    // Due yesterday, paid in full a week ago: on time, though typed in today.
    await LoanModel.updateOne(
      { _id: loanId },
      { $set: { disbursedAt: new Date(daysAgo(100)), dueDate: new Date(daysAgo(1)) } },
    );
    const result = await loans.repayCash(
      officer,
      loanId,
      110_000,
      randomUUID(),
      'cash',
      undefined,
      daysAgo(7),
    );
    expect(result.loan).toMatchObject({ status: 'repaid', repaidOnTime: true });
  });
});

describe('the loan savings account', () => {
  it('is one per customer', async () => {
    const customerId = await makeCustomer(true);
    await openLoanSavings(customerId);
    await expect(openLoanSavings(customerId)).rejects.toMatchObject({
      code: 'LOAN_SAVINGS_EXISTS',
    });
  });

  it('takes deposits, but nothing comes out of it as a withdrawal or a transfer', async () => {
    const customerId = await makeCustomer(true);
    const accountId = await openLoanSavings(customerId, 50_000);
    await savings.deposit(officer, accountId, 10_000, randomUUID(), 'cash');
    const account = await savings.getAccount(officer, accountId);
    expect(account).toMatchObject({ balance: 60_000, availableToWithdraw: 0 });

    await expect(savings.withdraw(officer, accountId, 1_000, randomUUID())).rejects.toMatchObject({
      code: 'LOAN_SAVINGS_LOCKED',
    });
    await expect(savings.closeAccount(officer, accountId)).rejects.toMatchObject({
      code: 'LOAN_SAVINGS_LOCKED',
    });
    const other = await openSavings(customerId);
    await expect(
      transfer(officer, {
        from: { type: 'savings', accountId },
        to: { type: 'savings', accountId: other },
        amount: 1_000,
        idempotencyKey: randomUUID(),
      } as never),
    ).rejects.toMatchObject({ code: 'LOAN_SAVINGS_LOCKED' });
  });

  it('pays the loan, free of the withdrawal rules', async () => {
    const customerId = await makeCustomer(true);
    const accountId = await openLoanSavings(customerId, 50_000);
    const loanId = await activeLoan(customerId);

    const result = await loans.repayFromLoanSavings(officer, loanId, 45_000, randomUUID());
    expect(result.loanSavingsWithdrawal).toMatchObject({ amount: 45_000, balanceAfter: 5_000 });
    expect(result.loan.totalRepaid).toBe(45_000);
    // Twice in a day is fine: this is not a withdrawal.
    await loans.repayFromLoanSavings(officer, loanId, 5_000, randomUUID());
    expect((await SavingsAccountModel.findById(accountId))?.balance).toBe(0);

    const repayment = await RepaymentModel.findById(result.repayment.id);
    expect(repayment).toMatchObject({ source: 'loan-savings', channel: 'transfer' });
    expect(repayment?.savingsAccountId?.equals(accountId)).toBe(true);
    const txns = await SavingsTxnModel.find({ accountId, type: 'withdrawal' }).sort({ _id: 1 });
    expect(txns.map((t) => [t.amount, t.fee, t.channel])).toEqual([
      [45_000, 0, 'transfer'],
      [5_000, 0, 'transfer'],
    ]);

    // Nothing left in it: more is refused.
    await expect(
      loans.repayFromLoanSavings(officer, loanId, 1_000, randomUUID()),
    ).rejects.toMatchObject({ code: 'EXCEEDS_AVAILABLE' });
    // Empty, it may close.
    await savings.closeAccount(officer, accountId);
  });

  it('is refused for a customer who has none', async () => {
    const customerId = await makeCustomer(true);
    const loanId = await activeLoan(customerId);
    await expect(
      loans.repayFromLoanSavings(officer, loanId, 1_000, randomUUID()),
    ).rejects.toMatchObject({ code: 'NO_LOAN_SAVINGS' });
  });
});

describe('the month-end deduction', () => {
  /** The last day of the month the loan's first instalment falls in. */
  async function firstMonthEnd(loanId: Types.ObjectId): Promise<Date> {
    const first = await LoanScheduleModel.findOne({ loanId, installmentNumber: 1 });
    const due = first?.dueDate ?? new Date();
    return new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth() + 1, 0, 12));
  }

  it("takes the month's instalment, once however often it runs", async () => {
    const customerId = await makeCustomer(true);
    const accountId = await openLoanSavings(customerId, 100_000);
    const loanId = await activeLoan(customerId);
    const first = await LoanScheduleModel.findOne({ loanId, installmentNumber: 1 });
    const at = await firstMonthEnd(loanId);

    await runLoanSavingsPass(at);
    await runLoanSavingsPass(at);

    const loan = await LoanModel.findById(loanId);
    expect(loan?.totalRepaid).toBe(first?.amountDue);
    expect(loan?.loanSavingsMonth).toBe(at.toISOString().slice(0, 7));
    expect((await SavingsAccountModel.findById(accountId))?.balance).toBe(
      100_000 - (first?.amountDue ?? 0),
    );
    const repayments = await RepaymentModel.find({ loanId });
    expect(repayments).toHaveLength(1);
    expect(repayments[0]?.source).toBe('loan-savings');
  });

  it('takes what is there when there is less than is due', async () => {
    const customerId = await makeCustomer(true);
    const accountId = await openLoanSavings(customerId, 10_000);
    const loanId = await activeLoan(customerId);
    await runLoanSavingsPass(await firstMonthEnd(loanId));
    expect((await LoanModel.findById(loanId))?.totalRepaid).toBe(10_000);
    expect((await SavingsAccountModel.findById(accountId))?.balance).toBe(0);
  });

  it('takes nothing when the month was already paid in cash', async () => {
    const customerId = await makeCustomer(true);
    const accountId = await openLoanSavings(customerId, 100_000);
    const loanId = await activeLoan(customerId);
    const first = await LoanScheduleModel.findOne({ loanId, installmentNumber: 1 });
    await loans.repayCash(officer, loanId, first?.amountDue ?? 0, randomUUID(), 'cash');
    await runLoanSavingsPass(await firstMonthEnd(loanId));
    expect((await SavingsAccountModel.findById(accountId))?.balance).toBe(100_000);
  });

  it('does nothing in the middle of a month', async () => {
    const customerId = await makeCustomer(true);
    const accountId = await openLoanSavings(customerId, 100_000);
    const loanId = await activeLoan(customerId);
    const end = await firstMonthEnd(loanId);
    const midMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 15, 12));
    const result = await runLoanSavingsPass(midMonth);
    expect(result.month).toBeNull();
    expect((await SavingsAccountModel.findById(accountId))?.balance).toBe(100_000);
  });
});

async function openSavings(customerId: Types.ObjectId): Promise<Types.ObjectId> {
  const { account } = await savings.openAccount(officer, customerId, 5_000, randomUUID(), 'cash');
  return new Types.ObjectId(account.id);
}
