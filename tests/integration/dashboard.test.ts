import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { accraDay } from '../../src/lib/time.js';
import {
  LoanModel,
  RepaymentModel,
  SavingsAccountModel,
  SavingsTxnModel,
  SusuAccountModel,
  SusuDepositModel,
  SusuPayoutModel,
  TransferModel,
} from '../../src/models/index.js';
import { dashboardMetrics } from '../../src/modules/reports/dashboard.service.js';
import { makeCustomer, setupDb, teardownDb } from './helpers.js';

beforeAll(setupDb);
afterAll(teardownDb);

const staffId = new Types.ObjectId();

/**
 * One customer, one money event per module, plus an internal savings → loan
 * transfer written the way the transfers service writes it. Amounts mirror
 * the transactions feed test so the two suites cross-check the same math.
 */
async function seed(): Promise<void> {
  const customerId = await makeCustomer();

  const susuAccount = await SusuAccountModel.create({
    accountNumber: '123456',
    customerId,
    dailyAmount: 1_000,
    depositsCount: 1,
    totalDeposited: 1_000,
    openedById: staffId,
  });
  await SusuDepositModel.create({
    accountId: susuAccount._id,
    customerId,
    collectorId: staffId,
    amount: 1_000, // in
    daysCovered: 1,
    seqStart: 1,
    seqEnd: 1,
    channel: 'cash',
  });
  await SusuPayoutModel.create({
    accountId: susuAccount._id,
    customerId,
    amount: 500, // out
    destination: 'cash',
    recordedById: staffId,
  });

  const savingsAccount = await SavingsAccountModel.create({
    accountNumber: '1000000001',
    customerId,
    balance: 7_000,
    openedById: staffId,
  });
  // Student account: label only — should appear in the byType breakdown.
  await SavingsAccountModel.create({
    accountNumber: '1000000002',
    customerId,
    accountType: 'student',
    balance: 2_000,
    openedById: staffId,
  });
  await SavingsTxnModel.create({
    accountId: savingsAccount._id,
    customerId,
    type: 'deposit',
    amount: 10_000, // in
    balanceAfter: 10_000,
    channel: 'cash',
    accraDay: accraDay(),
    recordedById: staffId,
  });

  const loan = await LoanModel.create({
    customerId,
    tier: 'small',
    principal: 100_000,
    durationMonths: 3,
    ratePercent: 10,
    interestAmount: 10_000,
    totalDue: 110_000,
    totalRepaid: 5_000,
    status: 'active',
    appliedAt: new Date(),
    approvedById: staffId,
    disbursedAt: new Date(), // out today: 100_000
  });
  await RepaymentModel.create({
    loanId: loan._id,
    customerId,
    amount: 2_000, // in
    source: 'cash',
    channel: 'cash',
    recordedById: staffId,
  });

  // Internal transfer legs: savings withdrawal (fee 1_000) → loan repayment.
  await SavingsTxnModel.create({
    accountId: savingsAccount._id,
    customerId,
    type: 'withdrawal',
    amount: 3_000,
    fee: 1_000,
    balanceAfter: 7_000,
    channel: 'transfer',
    accraDay: accraDay(),
    recordedById: staffId,
  });
  await RepaymentModel.create({
    loanId: loan._id,
    customerId,
    amount: 3_000,
    source: 'transfer',
    channel: 'transfer',
    recordedById: staffId,
  });
  await TransferModel.create({
    customerId,
    fromType: 'savings',
    fromId: savingsAccount._id,
    toType: 'loan',
    toId: loan._id,
    amountMoved: 3_000,
    fee: 1_000,
    amountCredited: 3_000,
    excessPending: 0,
    recordedById: staffId,
  });
}

describe('dashboard metrics (WBS 6.1)', () => {
  it('reports today’s cash by source, MTD revenue, and portfolio position', async () => {
    await seed();
    const m = await dashboardMetrics();

    // Today: internal transfer legs move nothing in cash.
    expect(m.today.cashIn).toEqual({ count: 3, amount: 13_000 });
    expect(m.today.cashOut).toEqual({ count: 2, amount: 100_500 });
    expect(m.today.internalMoves.count).toBe(3);
    expect(m.today.in.susuDeposits).toEqual({ count: 1, amount: 1_000 });
    expect(m.today.in.savingsDeposits).toEqual({ count: 1, amount: 10_000 });
    expect(m.today.in.loanRepayments).toEqual({ count: 1, amount: 2_000 });
    expect(m.today.in.hpPayments).toEqual({ count: 0, amount: 0 });
    expect(m.today.out.susuPayouts).toEqual({ count: 1, amount: 500 });
    expect(m.today.out.loanDisbursements).toEqual({ count: 1, amount: 100_000 });
    expect(m.today.out.savingsWithdrawals).toEqual({ count: 0, amount: 0 }); // transfer leg is internal

    // Month to date: the transfer's savings fee is real revenue.
    expect(m.monthToDate.savingsFees).toEqual({ count: 1, amount: 1_000 });
    expect(m.monthToDate.totalRevenue).toBe(1_000);

    // Portfolio position.
    expect(m.portfolio.customersActive).toBe(1);
    expect(m.portfolio.susu.activeAccounts).toBe(1);
    expect(m.portfolio.susu.valueHeld).toBe(1_000);
    expect(m.portfolio.susu.pendingPayout).toEqual({ count: 0, amount: 0 });
    expect(m.portfolio.savings.activeAccounts).toBe(2);
    expect(m.portfolio.savings.totalBalance).toBe(9_000);
    expect(m.portfolio.savings.byType.standard).toEqual({ count: 1, amount: 7_000 });
    expect(m.portfolio.savings.byType.student).toEqual({ count: 1, amount: 2_000 });
    expect(m.portfolio.loans).toEqual({ active: 1, arrears: 0, outstanding: 105_000 });
    expect(m.portfolio.hirePurchase).toEqual({ active: 0, inArrears: 0, outstanding: 0 });
  });
});
