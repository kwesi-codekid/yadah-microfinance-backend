import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSusuLoanPass } from '../../src/lib/susu-loan.js';
import { accraDay } from '../../src/lib/time.js';
import {
  LoanModel,
  LoanScheduleModel,
  RepaymentModel,
  SavingsAccountModel,
  SavingsTxnModel,
  SusuLoanAccountModel,
  SusuLoanTxnModel,
} from '../../src/models/index.js';
import { balanceSheet } from '../../src/modules/accounting/balance-sheet.service.js';
import * as loans from '../../src/modules/loans/loans.service.js';
import { recordPaperLoan } from '../../src/modules/loans/paper-loans.service.js';
import { listTransactions } from '../../src/modules/reports/transactions.service.js';
import * as savings from '../../src/modules/savings/savings.service.js';
import * as susuLoans from '../../src/modules/susu-loans/susu-loans.service.js';
import { migrateLoanSavings } from '../../src/scripts/migrate-loan-savings.js';
import { asOfficer, makeCustomer, makeGuarantor, setupDb, teardownDb } from './helpers.js';

/**
 * Client decisions of 23 Oct 2026: the susu loan account replaces loan
 * savings — no susu rules, office deposits of any amount, no withdrawals —
 * and pays the loan by itself on the loan's own monthly dates.
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
async function activeLoan(customerId: Types.ObjectId): Promise<Types.ObjectId> {
  const applied = await loans.applyForLoan(officer, customerId, 100_000, 3, guarantor);
  const loanId = new Types.ObjectId(applied.id);
  await loans.approveLoan(officer, loanId);
  return loanId;
}

async function openSusuLoan(customerId: Types.ObjectId, deposit?: number) {
  const { account } = await susuLoans.openAccount(
    officer,
    customerId,
    deposit,
    deposit === undefined ? undefined : randomUUID(),
  );
  return new Types.ObjectId(account.id);
}

async function openSavings(customerId: Types.ObjectId): Promise<Types.ObjectId> {
  const { account } = await savings.openAccount(officer, customerId, 5_000, randomUUID(), 'cash');
  return new Types.ObjectId(account.id);
}

const balanceOf = async (id: Types.ObjectId) => (await SusuLoanAccountModel.findById(id))?.balance;
const repaidOn = async (id: Types.ObjectId) => (await LoanModel.findById(id))?.totalRepaid;

describe('the susu loan account', () => {
  it('is one per customer, numbered in its own SL run', async () => {
    const customerId = await makeCustomer(true);
    const { account } = await susuLoans.openAccount(officer, customerId, undefined, undefined);
    expect(account.accountNumber).toMatch(/^SL\d{8,}$/);
    await expect(openSusuLoan(customerId)).rejects.toMatchObject({ code: 'SUSU_LOAN_EXISTS' });
  });

  it('takes any amount, and cannot be closed with money in it', async () => {
    const customerId = await makeCustomer(true);
    const accountId = await openSusuLoan(customerId, 1);
    const { account } = await susuLoans.deposit(officer, accountId, 2_350, randomUUID(), 'cash');
    expect(account.balance).toBe(2_351);
    await expect(susuLoans.closeAccount(officer, accountId)).rejects.toMatchObject({
      code: 'SUSU_LOAN_NOT_EMPTY',
    });
  });

  it('is cash in on the feed, and held for the customer on the balance sheet', async () => {
    const before = await balanceSheet();
    const customerId = await makeCustomer(true);
    await openSusuLoan(customerId, 40_000);
    const feed = await listTransactions({
      customerId,
      page: 1,
      limit: 50,
      includePending: false,
      format: 'json',
    } as never);
    expect(feed.items.map((r) => [r.type, r.direction, r.amount])).toEqual([
      ['susu-loan-deposit', 'in', 40_000],
    ]);
    expect(feed.items[0]?.ref.accountNumber).toMatch(/^SL/);
    const after = await balanceSheet();
    expect(
      after.liabilities.customerDeposits.susuLoanBalances -
        before.liabilities.customerDeposits.susuLoanBalances,
    ).toBe(40_000);
  });

  it('pays the loan by hand, as a transfer off the cash book', async () => {
    const customerId = await makeCustomer(true);
    const accountId = await openSusuLoan(customerId, 50_000);
    const loanId = await activeLoan(customerId);

    const result = await loans.repayFromSusuLoan(officer, loanId, 45_000, randomUUID());
    expect(result.susuLoanWithdrawal).toMatchObject({ amount: 45_000, balanceAfter: 5_000 });
    const repayment = await RepaymentModel.findById(result.repayment.id);
    expect(repayment).toMatchObject({ source: 'susu-loan', channel: 'transfer' });
    expect(repayment?.susuLoanAccountId?.equals(accountId)).toBe(true);
    const rows = await SusuLoanTxnModel.find({ accountId, type: 'repayment' });
    expect(rows.map((t) => [t.amount, t.channel, t.loanId?.toHexString()])).toEqual([
      [45_000, 'transfer', loanId.toHexString()],
    ]);
    await expect(
      loans.repayFromSusuLoan(officer, loanId, 6_000, randomUUID()),
    ).rejects.toMatchObject({ code: 'EXCEEDS_AVAILABLE' });
  });

  it('is refused for a customer who has none', async () => {
    const customerId = await makeCustomer(true);
    const loanId = await activeLoan(customerId);
    await expect(
      loans.repayFromSusuLoan(officer, loanId, 1_000, randomUUID()),
    ).rejects.toMatchObject({ code: 'NO_SUSU_LOAN' });
  });

  it('gets its money back when the loan is deleted', async () => {
    const customerId = await makeCustomer(true);
    const accountId = await openSusuLoan(customerId, 50_000);
    const loanId = await activeLoan(customerId);
    await loans.repayFromSusuLoan(officer, loanId, 30_000, randomUUID());
    await loans.trashLoan(officer, loanId, 'entered by mistake');
    expect(await balanceOf(accountId)).toBe(50_000);
    expect(await SusuLoanTxnModel.countDocuments({ accountId, type: 'refund' })).toBe(1);
  });
});

describe('the susu loan deduction', () => {
  /** The first instalment, moved so it fell due `days` ago (0 = today). */
  async function firstDueDaysAgo(loanId: Types.ObjectId, days: number) {
    const first = await LoanScheduleModel.findOne({ loanId, installmentNumber: 1 });
    if (!first) throw new Error('no schedule');
    first.dueDate = new Date(Date.now() - days * 86_400_000);
    await first.save();
    return first;
  }

  it("takes the instalment on the loan's monthly date, once however often it runs", async () => {
    const customerId = await makeCustomer(true);
    const accountId = await openSusuLoan(customerId, 100_000);
    const loanId = await activeLoan(customerId);
    const first = await LoanScheduleModel.findOne({ loanId, installmentNumber: 1 });
    const onTheDay = first?.dueDate ?? new Date();

    await runSusuLoanPass(onTheDay);
    await runSusuLoanPass(onTheDay);

    expect(await repaidOn(loanId)).toBe(first?.amountDue);
    expect(await balanceOf(accountId)).toBe(100_000 - (first?.amountDue ?? 0));
    const repayments = await RepaymentModel.find({ loanId });
    expect(repayments.map((r) => r.source)).toEqual(['susu-loan']);
  });

  it('takes nothing the day before the date, nor at a month end before it', async () => {
    const customerId = await makeCustomer(true);
    const accountId = await openSusuLoan(customerId, 100_000);
    const loanId = await activeLoan(customerId);
    const first = await LoanScheduleModel.findOne({ loanId, installmentNumber: 1 });
    const due = first?.dueDate ?? new Date();
    await runSusuLoanPass(new Date(due.getTime() - 86_400_000));
    await runSusuLoanPass(new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), 0, 12)));
    expect(await balanceOf(accountId)).toBe(100_000);
  });

  it('takes what is there, then each deposit at once until the month is covered', async () => {
    const customerId = await makeCustomer(true);
    const accountId = await openSusuLoan(customerId, 10_000);
    const loanId = await activeLoan(customerId);
    const first = await firstDueDaysAgo(loanId, 2);

    await runSusuLoanPass();
    expect(await repaidOn(loanId)).toBe(10_000);
    expect(await balanceOf(accountId)).toBe(0);

    // A deposit in between dates goes straight to the short month...
    const short = first.amountDue - 10_000;
    const { account } = await susuLoans.deposit(
      officer,
      accountId,
      short + 7_000,
      randomUUID(),
      'cash',
    );
    expect(await repaidOn(loanId)).toBe(first.amountDue);
    // ...and once it is covered, the rest waits for the next date.
    expect(account.balance).toBe(7_000);
    await susuLoans.deposit(officer, accountId, 5_000, randomUUID(), 'cash');
    expect(await balanceOf(accountId)).toBe(12_000);
    expect(await repaidOn(loanId)).toBe(first.amountDue);
  });

  it('catches an old paper loan up, counting what the paper says was repaid', async () => {
    const customerId = await makeCustomer(true);
    const accountId = await openSusuLoan(customerId, 500_000);
    // GHS 3,300 over 3 months, out 75 days ago: two instalments (2,200) due.
    const paper = await recordPaperLoan(officer, {
      customerId,
      principal: 300_000,
      durationMonths: 3,
      ratePercent: 10,
      disbursedOn: daysAgo(75),
      guarantors: [],
      repayments: [{ paidOn: daysAgo(40), amount: 150_000 }],
    });
    const loanId = new Types.ObjectId(paper.id);

    await runSusuLoanPass();
    expect(await repaidOn(loanId)).toBe(220_000);
    expect(await balanceOf(accountId)).toBe(500_000 - 70_000);
  });

  it('leaves a paper loan alone when the paper repayments already cover it', async () => {
    const customerId = await makeCustomer(true);
    const accountId = await openSusuLoan(customerId, 500_000);
    await recordPaperLoan(officer, {
      customerId,
      principal: 300_000,
      durationMonths: 3,
      ratePercent: 10,
      disbursedOn: daysAgo(75),
      guarantors: [],
      repayments: [{ paidOn: daysAgo(10), amount: 250_000 }],
    });
    await runSusuLoanPass();
    expect(await balanceOf(accountId)).toBe(500_000);
  });

  it('takes nothing when the month was already paid in cash', async () => {
    const customerId = await makeCustomer(true);
    const accountId = await openSusuLoan(customerId, 100_000);
    const loanId = await activeLoan(customerId);
    const first = await firstDueDaysAgo(loanId, 0);
    await loans.repayCash(officer, loanId, first.amountDue, randomUUID(), 'cash');
    await runSusuLoanPass();
    expect(await balanceOf(accountId)).toBe(100_000);
  });

  it('moves what is left to savings when the loan is paid off — once', async () => {
    const customerId = await makeCustomer(true);
    const savingsId = await openSavings(customerId);
    const accountId = await openSusuLoan(customerId, 30_000);
    const loanId = await activeLoan(customerId);
    const loan = await LoanModel.findById(loanId);
    await loans.repayCash(officer, loanId, (loan?.totalDue ?? 0) - 20_000, randomUUID(), 'cash');

    // The last 20 000 from the susu loan account pays it off; 10 000 is left.
    await loans.repayFromSusuLoan(officer, loanId, 20_000, randomUUID());
    expect((await LoanModel.findById(loanId))?.status).toBe('repaid');
    expect(await balanceOf(accountId)).toBe(0);
    expect((await SavingsAccountModel.findById(savingsId))?.balance).toBe(5_000 + 10_000);
    expect(await SusuLoanTxnModel.countDocuments({ accountId, type: 'leftover' })).toBe(1);
    const inLeg = await SavingsTxnModel.findOne({ accountId: savingsId, channel: 'transfer' });
    expect(inLeg).toMatchObject({ type: 'deposit', amount: 10_000 });

    // Paid in afterwards, towards the next loan: it stays.
    await susuLoans.deposit(officer, accountId, 4_000, randomUUID(), 'cash');
    const repaid = await LoanModel.findById(loanId);
    if (repaid) await loans.afterLoanRepayment(officer, repaid);
    expect(await balanceOf(accountId)).toBe(4_000);
  });

  it('leaves the leftover where it is when there is no savings account', async () => {
    const customerId = await makeCustomer(true);
    const accountId = await openSusuLoan(customerId, 200_000);
    const loanId = await activeLoan(customerId);
    const loan = await LoanModel.findById(loanId);
    await loans.repayFromSusuLoan(officer, loanId, loan?.totalDue ?? 0, randomUUID());
    expect(await balanceOf(accountId)).toBe(200_000 - (loan?.totalDue ?? 0));
  });
});

describe('converting loan savings accounts', () => {
  it('moves the account, its history and its repayments to a susu loan account', async () => {
    const customerId = await makeCustomer(true);
    const loanId = await activeLoan(customerId);
    // A loan savings account as the retired code left it.
    const old = await SavingsAccountModel.create({
      accountNumber: `SV2610${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`,
      customerId,
      accountType: 'loan',
      balance: 30_000,
      openedById: new Types.ObjectId(officer.sub),
    });
    const key = randomUUID();
    await SavingsTxnModel.create([
      {
        accountId: old._id,
        customerId,
        type: 'deposit',
        amount: 50_000,
        balanceAfter: 50_000,
        channel: 'cash',
        accraDay: accraDay(),
        recordedById: new Types.ObjectId(officer.sub),
      },
      {
        accountId: old._id,
        customerId,
        type: 'withdrawal',
        amount: 20_000,
        fee: 0,
        balanceAfter: 30_000,
        channel: 'transfer',
        accraDay: accraDay(),
        recordedById: new Types.ObjectId(officer.sub),
        idempotencyKey: `loan-savings:${key}`,
      },
    ]);
    await RepaymentModel.create({
      loanId,
      customerId,
      amount: 20_000,
      source: 'loan-savings',
      channel: 'transfer',
      savingsAccountId: old._id,
      recordedById: new Types.ObjectId(officer.sub),
      idempotencyKey: key,
    });

    const dry = await migrateLoanSavings(false);
    expect(await SavingsAccountModel.exists({ _id: old._id })).toBeTruthy();
    expect(dry.converted.some((c) => c.from === old.accountNumber)).toBe(true);

    const run = await migrateLoanSavings(true);
    const done = run.converted.find((c) => c.from === old.accountNumber);
    expect(done).toMatchObject({ balance: 30_000, rows: 2 });
    expect(run.balanceBefore).toBe(run.balanceAfter);

    const account = await SusuLoanAccountModel.findOne({ migratedFromSavingsId: old._id });
    expect(account).toMatchObject({ balance: 30_000, status: 'active' });
    expect(account?.accountNumber).toBe(done?.to);
    const rows = await SusuLoanTxnModel.find({ accountId: account?._id }).sort({ createdAt: 1 });
    expect(rows.map((r) => [r.type, r.amount, r.balanceAfter, r.loanId?.toHexString()])).toEqual([
      ['deposit', 50_000, 50_000, undefined],
      ['repayment', 20_000, 30_000, loanId.toHexString()],
    ]);
    const repayment = await RepaymentModel.findOne({ idempotencyKey: key });
    expect(repayment).toMatchObject({ source: 'susu-loan' });
    expect(repayment?.susuLoanAccountId?.equals(account?._id)).toBe(true);
    expect(await SavingsAccountModel.exists({ _id: old._id })).toBeNull();
    expect(await SavingsTxnModel.countDocuments({ accountId: old._id })).toBe(0);

    // Run again: nothing left to convert.
    const again = await migrateLoanSavings(true);
    expect(again.converted.some((c) => c.from === old.accountNumber)).toBe(false);
  });
});
