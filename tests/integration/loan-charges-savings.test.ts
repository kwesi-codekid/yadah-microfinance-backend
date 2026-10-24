import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accraDay } from '../../src/lib/time.js';
import { LoanModel, RepaymentModel } from '../../src/models/index.js';
import * as loans from '../../src/modules/loans/loans.service.js';
import { recordPaperLoan } from '../../src/modules/loans/paper-loans.service.js';
import * as savings from '../../src/modules/savings/savings.service.js';
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
  it('is no longer opened — the susu loan account replaced it', async () => {
    const customerId = await makeCustomer(true);
    await expect(openLoanSavings(customerId)).rejects.toMatchObject({
      code: 'LOAN_SAVINGS_RETIRED',
    });
  });
});
