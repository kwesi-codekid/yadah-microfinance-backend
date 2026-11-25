import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { accraDay } from '../../src/lib/time.js';
import { LoanModel, SusuDepositModel } from '../../src/models/index.js';
import { balanceSheet, profitAndLoss } from '../../src/modules/accounting/balance-sheet.service.js';
import * as cash from '../../src/modules/accounting/cash.service.js';
import * as assets from '../../src/modules/accounting/fixed-assets.service.js';
import { dashboardMetrics } from '../../src/modules/dashboard/dashboard.service.js';
import { cashSeries } from '../../src/modules/dashboard/series.service.js';
import { commissionBalance } from '../../src/modules/commissions/commissions.service.js';
import { dashboardFinancials } from '../../src/modules/dashboard/financials.service.js';
import * as hp from '../../src/modules/hire-purchase/hp.service.js';
import * as loans from '../../src/modules/loans/loans.service.js';
import { collectionsByStaff, commissionEarned } from '../../src/modules/reports/reports.service.js';
import { listTransactions } from '../../src/modules/reports/transactions.service.js';
import * as savings from '../../src/modules/savings/savings.service.js';
import * as susu from '../../src/modules/susu/susu.service.js';
import { transfer } from '../../src/modules/transfers/transfers.service.js';
import { asOfficer, makeCustomer, makeGuarantor, setupDb, teardownDb } from './helpers.js';

/**
 * One figure, one answer. Every kind of money movement the app records is run
 * here, and after each the books are asked the same questions through every
 * door that answers them: the balance sheet must still balance, and the
 * dashboard, the ledger and the reports must state the same amounts.
 *
 * A step that breaks the identity is named rather than stopping the run, so
 * one pass lists every movement that lands on only one side of the sheet.
 */

const officer = asOfficer();
const today = accraDay();
const OPENING = '2026-01-01';
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * OPEN, waiting on the client (found 25 Nov 2026) — not correct, only known.
 * Stock has no funding side: taking it in adds an asset with no cash paid and
 * no capital recorded. And a hire purchase sale never books its profit: the
 * unit leaves stock at cost when the agreement is signed, the customer then
 * owes the selling price, and the difference lands nowhere. How stock is paid
 * for and when that profit counts are accounting rules for the client to set;
 * when they are, this list must go back to empty.
 */
const KNOWN_OPEN = [
  'stock taken in: sheet off by 500000 pesewas',
  'hire purchase signed (unit reserved): sheet off by -100000 pesewas',
  'hire purchase deposit: sheet off by 200000 pesewas',
];
const KNOWN_OPEN_DIFFERENCE = 600_000;

let guarantor: Types.ObjectId;
const broken: string[] = [];

beforeAll(async () => {
  await setupDb();
  guarantor = await makeGuarantor();
  await cash.createAccount(officer, {
    name: 'Office drawer',
    kind: 'cash-on-hand',
    channel: 'cash',
    openingBalance: 100_000_000,
    openingDate: OPENING,
  });
  await assets.recordCapital(officer, {
    kind: 'contribution',
    amount: 100_000_000,
    occurredOn: OPENING,
    note: 'Opening capital',
  });
});
afterAll(teardownDb);

/** Runs one movement and notes it when the sheet stops balancing because of it. */
async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  const before = (await balanceSheet(today)).checkDifference;
  const result = await run();
  const after = (await balanceSheet(today)).checkDifference;
  if (after !== before) broken.push(`${name}: sheet off by ${String(after - before)} pesewas`);
  return result;
}

const oid = (id: string) => new Types.ObjectId(id);

/** A customer with a susu book holding `payments` payments of GHS 20. */
async function saver(
  payments = 10,
): Promise<{ customerId: Types.ObjectId; susuId: Types.ObjectId }> {
  const customerId = await makeCustomer(true);
  const { account } = await susu.openAccount(officer, customerId, 2_000);
  const susuId = oid(account.id);
  await susu.recordDeposit(officer, susuId, 2_000 * payments, randomUUID(), 'cash');
  return { customerId, susuId };
}

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
  await loans.approveLoan(officer, oid(applied.id));
  return oid(applied.id);
}

describe('every money movement keeps the books balanced', () => {
  it('susu: deposits, a finished cycle, withdrawals, closing', async () => {
    const customerId = await makeCustomer(true);
    const { account } = await step('susu open', () => susu.openAccount(officer, customerId, 1_000));
    const id = oid(account.id);
    await step('susu deposit', () => susu.recordDeposit(officer, id, 5_000, randomUUID(), 'cash'));
    // 31 payments in all: the cycle ends and its one payment is commission.
    await step('susu deposit ending a cycle (commission)', () =>
      susu.recordDeposit(officer, id, 26_000, randomUUID(), 'cash'),
    );
    await step('susu deposit into the next cycle', () =>
      susu.recordDeposit(officer, id, 4_000, randomUUID(), 'cash'),
    );
    await step('susu part withdrawal', () => susu.withdraw(officer, id, 10_000, randomUUID()));
    await step('susu close with a cycle in progress', () => susu.closeAccount(officer, id));
  });

  it('savings: opening deposit, deposit, fee-bearing withdrawal, closing', async () => {
    const customerId = await makeCustomer(true);
    const { account } = await step('savings open with deposit', () =>
      savings.openAccount(officer, customerId, 50_000, randomUUID(), 'cash'),
    );
    const id = oid(account.id);
    await step('savings deposit', () => savings.deposit(officer, id, 30_000, randomUUID(), 'cash'));
    await step('savings withdrawal (fee)', () =>
      savings.withdraw(officer, id, 10_000, randomUUID()),
    );
    // One withdrawal a day per account, so the closing is on a second book.
    const second = await savings.openAccount(officer, customerId, 50_000, randomUUID(), 'cash');
    await step('savings close (fee)', () => savings.closeAccount(officer, oid(second.account.id)));
  });

  it('loans: out with fee and collateral, repaid every way, raised, deleted', async () => {
    const { customerId, susuId } = await saver(20);
    const loanId = await step('loan out with fee and collateral', () =>
      activeLoan(customerId, { processingFee: 5_000, collateralAmount: 30_000 }),
    );
    await step('loan cash repayment', () =>
      loans.repayCash(officer, loanId, 33_333, randomUUID(), 'cash'),
    );
    await step('loan repayment from susu', () =>
      loans.repayFromSusu(officer, loanId, susuId, 10_000, randomUUID()),
    );
    const fromCollateral = await step('loan repayment from collateral', () =>
      loans.repayFromCollateral(officer, loanId, 7_777, randomUUID()),
    );
    await step('loan rate raised by the office', async () => {
      const past = new Date(Date.now() - 4 * MONTH_MS);
      await LoanModel.updateOne(
        { _id: loanId },
        { $set: { approvedAt: past, disbursedAt: past } },
        { timestamps: false },
      );
      await loans.raiseLoanRate(officer, loanId);
    });
    await step('collateral repayment deleted', () =>
      loans.trashRepayment(officer, loanId, oid(fromCollateral.repayment.id), 'test'),
    );
    await step('loan settled in cash', async () => {
      const { loan } = await loans.getLoan(loanId);
      await loans.repayCash(officer, loanId, loan.remaining, randomUUID(), 'cash');
    });
    await step('collateral handed back', () => loans.returnCollateral(officer, loanId));

    const other = await saver(20);
    const doomed = await activeLoan(other.customerId, { processingFee: 2_000 });
    await loans.repayCash(officer, doomed, 20_000, randomUUID(), 'cash');
    await loans.repayFromSusu(officer, doomed, other.susuId, 10_000, randomUUID());
    await step('disbursed loan deleted with its repayments', () =>
      loans.trashLoan(officer, doomed, 'test'),
    );
  });

  it('transfers between a customer’s own products', async () => {
    const { customerId, susuId } = await saver(20);
    const { account } = await savings.openAccount(
      officer,
      customerId,
      80_000,
      randomUUID(),
      'cash',
    );
    const savingsId = oid(account.id);
    const loanId = await activeLoan(customerId);
    await step('transfer susu → savings', () =>
      transfer(officer, {
        from: { type: 'susu', accountId: susuId },
        to: { type: 'savings', accountId: savingsId },
        amount: 6_000,
        idempotencyKey: randomUUID(),
      } as never),
    );
    await step('transfer savings → loan (fee)', () =>
      transfer(officer, {
        from: { type: 'savings', accountId: savingsId },
        to: { type: 'loan', loanId },
        amount: 15_000,
        idempotencyKey: randomUUID(),
      } as never),
    );
    const second = await savings.openAccount(officer, customerId, 80_000, randomUUID(), 'cash');
    await step('transfer savings → susu (fee)', () =>
      transfer(officer, {
        from: { type: 'savings', accountId: oid(second.account.id) },
        to: { type: 'susu', accountId: susuId },
        amount: 4_000,
        idempotencyKey: randomUUID(),
      } as never),
    );
  });

  it('hire purchase and counter sales', async () => {
    const customerId = await makeCustomer(true);
    const { account } = await susu.openAccount(officer, customerId, 1_000);
    await susu.recordDeposit(officer, oid(account.id), 5_000, randomUUID(), 'cash');
    await SusuDepositModel.updateMany(
      { customerId },
      { $set: { createdAt: new Date(Date.now() - 130 * 24 * 60 * 60 * 1000) } },
      { timestamps: false, overwriteImmutable: true },
    );

    const item = await step('stock taken in', () =>
      hp.createItem(officer, {
        name: `Fridge ${randomUUID().slice(0, 6)}`,
        quantityInStock: 5,
        costPrice: 100_000,
        sellingPrice: 200_000,
      }),
    );
    const itemId = oid(item.id);
    const signed = await step('hire purchase signed (unit reserved)', () =>
      hp.createAgreement(officer, { customerId, itemId, agreedPrice: 200_000, durationMonths: 6 }),
    );
    const agreementId = oid(signed.id);
    await step('hire purchase deposit', () =>
      hp.recordDeposit(officer, agreementId, signed.depositRequired, randomUUID(), 'cash'),
    );
    await step('hire purchase instalment', () =>
      hp.payInstallment(officer, agreementId, 20_000, randomUUID(), 'cash'),
    );
    await step('hire purchase paid off', async () => {
      const { HpAgreementModel } = await import('../../src/models/index.js');
      const a = await HpAgreementModel.findById(agreementId);
      if (!a) throw new Error('agreement gone');
      await hp.payInstallment(officer, agreementId, hp.remainingOn(a), randomUUID(), 'cash');
    });
    const { sale } = await step('outright counter sale', () =>
      hp.recordSale(officer, {
        buyerName: 'Walk In',
        lines: [{ itemId, quantity: 1 }],
        idempotencyKey: randomUUID(),
        channel: 'cash',
      } as never),
    );
    await step('counter sale voided', () => hp.voidSale(officer, oid(sale.id), 'test'));
  });

  it('names every movement that left the sheet out of balance', () => {
    expect(broken).toEqual(KNOWN_OPEN);
  });
});

describe('the same figure reads the same everywhere', () => {
  it('dashboard, balance sheet, ledger and reports agree', async () => {
    const [sheet, dash, allTime, feed, pl, loanList, savingsList] = await Promise.all([
      balanceSheet(today),
      dashboardFinancials({ from: today, to: today, bucket: 'day' } as never),
      commissionEarned('2020-01-01', today),
      listTransactions({
        from: OPENING,
        to: today,
        page: 1,
        limit: 1,
        includePending: false,
        includeEntered: false,
        format: 'json',
      } as never),
      profitAndLoss('2020-01-01', today),
      loans.listLoans({
        page: 1,
        limit: 1,
        rateDue: false,
        collateralHeld: false,
        format: 'json',
      } as never),
      savings.listAccounts(officer, { page: 1, limit: 1, format: 'json' } as never),
    ]);

    const mismatches: string[] = [];
    const same = (name: string, a: number, b: number): void => {
      if (a !== b) mismatches.push(`${name}: ${String(a)} vs ${String(b)}`);
    };
    const commission =
      allTime.susuCommission.amount +
      allTime.savingsFees.amount +
      allTime.loanProcessingFees.amount;

    same('cash: dashboard vs balance sheet', dash.cash.total, sheet.assets.current.cashAndBank);
    same(
      'susu held: dashboard vs balance sheet',
      dash.deposits.susu,
      sheet.liabilities.customerDeposits.susuBalances,
    );
    same(
      'savings held: dashboard vs balance sheet',
      dash.deposits.savings,
      sheet.liabilities.customerDeposits.savingsBalances,
    );
    same(
      'savings held: savings page vs balance sheet',
      savingsList.totals.balance,
      sheet.liabilities.customerDeposits.savingsBalances,
    );
    same(
      'collateral: dashboard vs balance sheet',
      dash.deposits.collateral,
      sheet.liabilities.customerDeposits.collateralHeld,
    );
    same(
      'collateral: loans page vs balance sheet',
      loanList.totals.collateralHeld,
      sheet.liabilities.customerDeposits.collateralHeld,
    );
    same(
      'loans outstanding: dashboard vs loans page',
      dash.loanBook.loans.outstanding,
      loanList.totals.outstanding,
    );
    same(
      'loans outstanding: balance sheet (principal + unearned interest) vs loans page',
      sheet.assets.current.loansReceivable + sheet.disclosures.unearnedLoanInterest,
      loanList.totals.outstanding,
    );
    same(
      'hire purchase outstanding: balance sheet vs dashboard',
      sheet.assets.current.hirePurchaseReceivable + sheet.disclosures.unearnedHpInterest,
      dash.loanBook.hirePurchase.outstanding,
    );
    same('commission: dashboard vs commission report', dash.commissionAllTime, commission);
    same(
      'commission: ledger fee total vs commission report',
      feed.totals.feesCollected,
      commission,
    );
    same(
      'savings commission: savings page vs commission report',
      savingsList.totals.fees,
      allTime.savingsFees.amount,
    );
    same(
      'commission: profit and loss vs commission report',
      pl.income.susuCommission + pl.income.savingsFees + pl.income.loanProcessingFees,
      commission,
    );
    same('profit: all-time P&L vs retained earnings', pl.netProfit, sheet.equity.retainedEarnings);
    // Zero but for the open stock and hire purchase items above.
    same('balance sheet difference', sheet.checkDifference, KNOWN_OPEN_DIFFERENCE);
    const [metrics, series, held, staff, susuList, wholeFeed] = await Promise.all([
      dashboardMetrics(),
      cashSeries({ from: today, to: today, bucket: 'day' } as never),
      commissionBalance(today),
      collectionsByStaff(today, today),
      susu.listAccounts(officer, { page: 1, limit: 1, format: 'json' } as never),
      listTransactions({
        from: today,
        to: today,
        page: 1,
        limit: 500,
        includePending: false,
        includeEntered: false,
        format: 'json',
      } as never),
    ]);
    same(
      'susu held: counter dashboard vs office dashboard',
      metrics.portfolio.susu.valueHeld,
      dash.deposits.susu,
    );
    same(
      'savings held: counter dashboard vs office dashboard',
      metrics.portfolio.savings.totalBalance,
      dash.deposits.savings,
    );
    same(
      'loans outstanding: counter dashboard vs office dashboard',
      metrics.portfolio.loans.outstanding,
      dash.loanBook.loans.outstanding,
    );
    same(
      'hire purchase outstanding: counter dashboard vs office dashboard',
      metrics.portfolio.hirePurchase.outstanding,
      dash.loanBook.hirePurchase.outstanding,
    );
    same(
      'susu held: susu page vs balance sheet',
      susuList.totals.balance,
      sheet.liabilities.customerDeposits.susuBalances,
    );
    same(
      'susu page: deposited − withdrawn − commission vs balance held',
      susuList.totals.deposited - susuList.totals.withdrawn - susuList.totals.commission,
      susuList.totals.balance,
    );
    same(
      'savings page: deposited − withdrawn − commission vs balance held',
      savingsList.totals.deposited - savingsList.totals.withdrawn - savingsList.totals.fees,
      savingsList.totals.balance,
    );
    same(
      'susu commission: susu page vs commission report',
      susuList.totals.commission,
      allTime.susuCommission.amount,
    );
    same('commission account: commission page vs dashboard', held.balance, dash.cash.commission);
    same(
      'cash in today: dashboard tile vs ledger',
      metrics.today.cashIn.amount,
      wholeFeed.totals.in.amount,
    );
    same(
      'cash out today: dashboard vs ledger',
      metrics.today.cashOut.amount,
      wholeFeed.totals.out.amount,
    );
    same('cash in today: chart vs ledger', series.totals.cashIn.amount, wholeFeed.totals.in.amount);
    same(
      'cash out today: chart vs ledger',
      series.totals.cashOut.amount,
      wholeFeed.totals.out.amount,
    );
    const inParts = Object.values(metrics.today.in).reduce((sum, t) => sum + t.amount, 0);
    const outParts = Object.values(metrics.today.out).reduce((sum, t) => sum + t.amount, 0);
    same('cash in today: the parts vs the total', inParts, metrics.today.cashIn.amount);
    same('cash out today: the parts vs the total', outParts, metrics.today.cashOut.amount);
    const cashDeposits = wholeFeed.items
      .filter(
        (r) => (r.type === 'susu-deposit' || r.type === 'savings-deposit') && r.direction === 'in',
      )
      .reduce((sum, r) => sum + r.amount, 0);
    same('collections report vs cash deposits on the ledger', staff.totalAmount, cashDeposits);
    expect(mismatches).toEqual([]);
  });
});
