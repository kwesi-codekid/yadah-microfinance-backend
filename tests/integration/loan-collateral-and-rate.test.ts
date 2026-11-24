import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLogModel, LoanModel } from '../../src/models/index.js';
import { runEscalationPass } from '../../src/lib/loan-escalation.js';
import * as loans from '../../src/modules/loans/loans.service.js';
import { editLoan } from '../../src/modules/loans/loan-edit.service.js';
import { listTransactions } from '../../src/modules/reports/transactions.service.js';
import { balanceSheet } from '../../src/modules/accounting/balance-sheet.service.js';
import { dashboardAlerts } from '../../src/modules/dashboard/alerts.service.js';
import { asOfficer, makeCustomer, makeGuarantor, setupDb, teardownDb } from './helpers.js';

/**
 * Client decisions of 22 Nov 2026: a loan can be repaid out of its own cash
 * collateral; the collateral held is totalled on the loans list; and the rate
 * goes up only when the office raises it, the loan being flagged as due.
 */

let guarantor: Types.ObjectId;
beforeAll(async () => {
  await setupDb();
  guarantor = await makeGuarantor();
});
afterAll(teardownDb);

const officer = asOfficer();
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/** A GHS 1,000 loan over 3 months (due GHS 1,100), out today. */
async function activeLoan(collateralAmount?: number): Promise<Types.ObjectId> {
  const customerId = await makeCustomer(true);
  const applied = await loans.applyForLoan(
    officer,
    customerId,
    100_000,
    3,
    guarantor,
    undefined,
    undefined,
    collateralAmount ? { collateralAmount } : {},
  );
  const loanId = new Types.ObjectId(applied.id);
  await loans.approveLoan(officer, loanId);
  return loanId;
}

async function backdate(loanId: Types.ObjectId, months: number): Promise<void> {
  const past = new Date(Date.now() - months * MONTH_MS);
  await LoanModel.updateOne(
    { _id: loanId },
    {
      $set: {
        approvedAt: past,
        disbursedAt: past,
        dueDate: new Date(past.getTime() + 3 * MONTH_MS),
      },
    },
    { timestamps: false },
  );
}

describe('repaying from the collateral', () => {
  it('takes part of it, keeps the rest held, and moves no cash', async () => {
    const loanId = await activeLoan(30_000);
    const before = await balanceSheet();

    const result = await loans.repayFromCollateral(officer, loanId, 20_000, randomUUID());
    expect(result.repayment.source).toBe('collateral');
    expect(result.loan).toMatchObject({
      totalRepaid: 20_000,
      remaining: 90_000,
      collateralAmount: 30_000,
      collateralUsed: 20_000,
      collateralHeld: 10_000,
    });

    const after = await balanceSheet();
    expect(
      before.liabilities.customerDeposits.collateralHeld -
        after.liabilities.customerDeposits.collateralHeld,
    ).toBe(20_000);

    const loan = await LoanModel.findById(loanId);
    const feed = await listTransactions({
      customerId: loan!.customerId,
      page: 1,
      limit: 50,
      includePending: false,
      format: 'json',
    } as never);
    expect(feed.items.find((r) => r.type === 'loan-repayment')).toMatchObject({
      amount: 20_000,
      direction: 'internal',
    });
  });

  it('refuses more than is held, and more than is owed', async () => {
    const loanId = await activeLoan(30_000);
    await expect(
      loans.repayFromCollateral(officer, loanId, 30_001, randomUUID()),
    ).rejects.toMatchObject({ code: 'COLLATERAL_SHORT' });

    const big = await activeLoan(200_000);
    await expect(
      loans.repayFromCollateral(officer, big, 150_000, randomUUID()),
    ).rejects.toMatchObject({ code: 'EXCEEDS_BALANCE' });
  });

  it('refuses a loan with no collateral', async () => {
    const loanId = await activeLoan();
    await expect(
      loans.repayFromCollateral(officer, loanId, 1_000, randomUUID()),
    ).rejects.toMatchObject({ code: 'NO_COLLATERAL' });
  });

  it('can settle the loan; only what is left is handed back', async () => {
    const loanId = await activeLoan(150_000);
    const settled = await loans.repayFromCollateral(officer, loanId, 110_000, randomUUID());
    expect(settled.loan.status).toBe('repaid');

    const returned = await loans.returnCollateral(officer, loanId);
    expect(returned).toMatchObject({ collateralHeld: 0, collateralReturnedAmount: 40_000 });

    const feed = await listTransactions({
      customerId: (await LoanModel.findById(loanId))!.customerId,
      page: 1,
      limit: 50,
      includePending: false,
      format: 'json',
    } as never);
    expect(feed.items.find((r) => r.type === 'loan-collateral-return')).toMatchObject({
      amount: 40_000,
      direction: 'out',
    });
  });

  it('has nothing to hand back once all of it went to the loan', async () => {
    const loanId = await activeLoan(20_000);
    await loans.repayFromCollateral(officer, loanId, 20_000, randomUUID());
    await loans.repayCash(officer, loanId, 90_000, randomUUID(), 'cash');
    await expect(loans.returnCollateral(officer, loanId)).rejects.toMatchObject({
      code: 'NO_COLLATERAL',
    });
  });

  it('is replayed, not taken twice, on the same idempotency key', async () => {
    const loanId = await activeLoan(30_000);
    const key = randomUUID();
    await loans.repayFromCollateral(officer, loanId, 10_000, key);
    const again = await loans.repayFromCollateral(officer, loanId, 10_000, key);
    expect(again.replayed).toBe(true);
    expect((await LoanModel.findById(loanId))?.collateralUsed).toBe(10_000);
  });

  it('goes back into the collateral when the repayment is deleted', async () => {
    const loanId = await activeLoan(30_000);
    const { repayment } = await loans.repayFromCollateral(officer, loanId, 10_000, randomUUID());
    const { loan } = await loans.trashRepayment(
      officer,
      loanId,
      new Types.ObjectId(repayment.id),
      'Wrong loan',
    );
    expect(loan).toMatchObject({ totalRepaid: 0, collateralUsed: 0, collateralHeld: 30_000 });
  });

  it('keeps an edit from setting the collateral below what was used', async () => {
    const loanId = await activeLoan(30_000);
    await loans.repayFromCollateral(officer, loanId, 20_000, randomUUID());
    await expect(
      editLoan(officer, loanId, { collateralAmount: 10_000, reason: 'Typo' }),
    ).rejects.toMatchObject({ code: 'COLLATERAL_USED' });
  });

  it('is totalled on the loans list', async () => {
    const loanId = await activeLoan(25_000);
    await loans.repayFromCollateral(officer, loanId, 5_000, randomUUID());
    const list = await loans.listLoans({
      page: 1,
      limit: 100,
      collateralHeld: true,
      rateDue: false,
      format: 'json',
    } as never);
    expect(list.items.some((l) => l.id === loanId.toHexString())).toBe(true);
    expect(list.items.every((l) => (l.collateralHeld ?? 0) > 0)).toBe(true);
    expect(list.totals.collateralHeld).toBe(
      list.items.reduce((sum, l) => sum + (l.collateralHeld ?? 0), 0),
    );
  });
});

describe('the office raises the rate (no longer the worker)', () => {
  it('the worker leaves a loan past its window alone, and flags it as due', async () => {
    const loanId = await activeLoan();
    await backdate(loanId, 4); // 3-month/10% loan, 4 months old

    await runEscalationPass();
    const after = await LoanModel.findById(loanId);
    expect(after?.ratePercent).toBe(10);
    expect(after?.totalDue).toBe(110_000);

    const { loan } = await loans.getLoan(loanId);
    expect(loan.rateIncreaseDue).toEqual({ toRatePercent: 20, totalDue: 120_000 });

    const { alerts } = await dashboardAlerts();
    expect(alerts.find((a) => a.key === 'loans-rate-increase-due')?.count).toBeGreaterThan(0);
    const due = await loans.listLoans({
      page: 1,
      limit: 100,
      rateDue: true,
      collateralHeld: false,
      format: 'json',
    } as never);
    expect(due.items.some((l) => l.id === loanId.toHexString())).toBe(true);
    expect(due.totals.rateIncreaseDueCount).toBe(due.total);
  });

  it('raises it on the ORIGINAL principal when the office says so', async () => {
    const loanId = await activeLoan();
    await backdate(loanId, 4);
    const raised = await loans.raiseLoanRate(officer, loanId);
    expect(raised).toMatchObject({ ratePercent: 20, interestAmount: 20_000, totalDue: 120_000 });
    expect(raised.rateIncreaseDue).toBeUndefined();
    expect(await AuditLogModel.countDocuments({ action: 'loan.escalate', entityId: loanId })).toBe(
      1,
    );
    await expect(loans.raiseLoanRate(officer, loanId)).rejects.toMatchObject({
      code: 'NO_RATE_INCREASE_DUE',
    });
  });

  it('goes straight to the rate the ladder would have reached when the office is late', async () => {
    const loanId = await activeLoan();
    await backdate(loanId, 7); // past both the 3- and 6-month windows
    const raised = await loans.raiseLoanRate(officer, loanId);
    expect(raised.ratePercent).toBe(30);
  });

  it('refuses a loan not yet due', async () => {
    const loanId = await activeLoan();
    await expect(loans.raiseLoanRate(officer, loanId)).rejects.toMatchObject({
      code: 'NO_RATE_INCREASE_DUE',
    });
  });

  it('still puts a loan in arrears by itself past 12 months, even on a rate never raised', async () => {
    const loanId = await activeLoan();
    await backdate(loanId, 13);
    await runEscalationPass();
    const after = await LoanModel.findById(loanId);
    expect(after).toMatchObject({ status: 'arrears', frozen: true, ratePercent: 10 });
  });
});
