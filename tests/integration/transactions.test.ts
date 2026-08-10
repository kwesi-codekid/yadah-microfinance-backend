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
import {
  customerStatement,
  listTransactions,
} from '../../src/modules/reports/transactions.service.js';
import {
  transactionsQuery,
  type TransactionsQuery,
} from '../../src/modules/reports/reports.schemas.js';
import { makeCustomer, setupDb, teardownDb } from './helpers.js';

beforeAll(setupDb);
afterAll(teardownDb);

const staffId = new Types.ObjectId();

function query(overrides: Record<string, unknown> = {}): TransactionsQuery {
  return transactionsQuery.parse(overrides);
}

/**
 * Seeds one customer with a money event in every module plus an internal
 * transfer (savings → loan) written the way the transfers service writes it:
 * withdrawal leg with channel 'transfer', repayment with source 'transfer',
 * and the transfer cross-reference row.
 */
async function seedCustomer(): Promise<{
  customerId: Types.ObjectId;
  savingsAccountId: Types.ObjectId;
}> {
  const customerId = await makeCustomer();

  const susuAccount = await SusuAccountModel.create({
    accountNumber: String(Math.floor(100000 + Math.random() * 900000)),
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
    amount: 500, // out (cash payout)
    destination: 'cash',
    recordedById: staffId,
  });

  const savingsAccount = await SavingsAccountModel.create({
    accountNumber: String(Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)),
    customerId,
    balance: 7_000,
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
    disbursedAt: new Date(), // out: loan-disbursement of 100_000
  });
  await RepaymentModel.create({
    loanId: loan._id,
    customerId,
    amount: 2_000, // in (cash repayment)
    source: 'cash',
    channel: 'cash',
    recordedById: staffId,
  });

  // Internal transfer savings → loan, as the transfers service records it.
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

  return { customerId, savingsAccountId: savingsAccount._id };
}

describe('unified transaction feed', () => {
  it('unions every module, paginates, and totals only real cash', async () => {
    const { customerId } = await seedCustomer();

    const feed = await listTransactions(query({ customerId: customerId.toHexString() }));
    // 1 susu deposit + 1 payout + 2 savings txns + 1 disbursement + 2 repayments
    // + 1 transfer-leg withdrawal is already counted in savings txns → 8 rows total.
    expect(feed.total).toBe(8);
    expect(feed.items).toHaveLength(8);

    const byType = new Map(feed.items.map((r) => [r.type, r]));
    expect(byType.get('susu-deposit')?.direction).toBe('in');
    expect(byType.get('susu-payout')?.direction).toBe('out');
    expect(byType.get('loan-disbursement')?.amount).toBe(100_000);
    expect(byType.get('loan-disbursement')?.direction).toBe('out');
    expect(byType.get('savings-withdrawal')?.direction).toBe('internal');
    expect(byType.get('transfer')?.detail).toBe('savings->loan');

    // Cash totals exclude the three internal rows (withdrawal leg, transfer
    // repayment, transfer record).
    expect(feed.totals.in).toEqual({ count: 3, amount: 1_000 + 10_000 + 2_000 });
    expect(feed.totals.out).toEqual({ count: 2, amount: 500 + 100_000 });
    expect(feed.totals.internal.count).toBe(3);
    expect(feed.totals.feesCollected).toBe(1_000);

    // Names and account numbers resolve on the page.
    const susuRow = byType.get('susu-deposit');
    expect(susuRow?.customerName).toMatch(/^Test Customer/);
    expect(susuRow?.ref.accountNumber).toMatch(/^\d{6}$/);

    // Pagination: page size 3 → 3 rows, same total, same range totals.
    const page2 = await listTransactions(
      query({ customerId: customerId.toHexString(), page: 2, limit: 3 }),
    );
    expect(page2.items).toHaveLength(3);
    expect(page2.total).toBe(8);
    expect(page2.totals.in.count).toBe(3);

    // Module filter narrows to that module's rows only.
    const loansOnly = await listTransactions(
      query({ customerId: customerId.toHexString(), module: 'loans' }),
    );
    expect(loansOnly.total).toBe(3); // disbursement + 2 repayments
    expect(loansOnly.items.every((r) => r.module === 'loans')).toBe(true);
  });

  it('date range excludes events outside the window', async () => {
    const { customerId } = await seedCustomer();
    const feed = await listTransactions(
      query({ customerId: customerId.toHexString(), from: '2000-01-01', to: '2000-01-31' }),
    );
    expect(feed.total).toBe(0);
    expect(feed.totals.in.count).toBe(0);
  });
});

describe('statement of account', () => {
  it('reports products, period balances, and chronological transactions', async () => {
    const { customerId, savingsAccountId } = await seedCustomer();

    const statement = await customerStatement(customerId);
    expect(statement.customer.fullName).toMatch(/^Test Customer/);
    expect(statement.truncated).toBe(false);

    expect(statement.products.susu).toHaveLength(1);
    expect(statement.products.loans[0]?.remaining).toBe(105_000);

    const savings = statement.products.savings.find(
      (a) => a.accountId === savingsAccountId.toHexString(),
    );
    // No txns before the window → opening 0; last txn in window → closing 7 000.
    expect(savings?.openingBalance).toBe(0);
    expect(savings?.closingBalance).toBe(7_000);
    expect(savings?.currentBalance).toBe(7_000);

    expect(statement.transactions).toHaveLength(8);
    const times = statement.transactions.map((t) => t.createdAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(statement.totals.in.amount).toBe(13_000);
    expect(statement.totals.feesCollected).toBe(1_000);
  });

  it('rejects an unknown customer', async () => {
    await expect(customerStatement(new Types.ObjectId())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
