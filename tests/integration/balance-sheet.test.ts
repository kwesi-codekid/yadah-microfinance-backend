import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { accraDay } from '../../src/lib/time.js';
import { CashAccountModel } from '../../src/models/index.js';
import { balanceSheet, profitAndLoss } from '../../src/modules/accounting/balance-sheet.service.js';
import * as cash from '../../src/modules/accounting/cash.service.js';
import * as expenses from '../../src/modules/accounting/expenses.service.js';
import * as assets from '../../src/modules/accounting/fixed-assets.service.js';
import * as savings from '../../src/modules/savings/savings.service.js';
import * as susu from '../../src/modules/susu/susu.service.js';
import { asOfficer, makeCustomer, setupDb, teardownDb } from './helpers.js';

beforeAll(setupDb);
afterAll(teardownDb);

const admin = asOfficer();
/** A second officer, because an expense cannot be approved by its recorder. */
const approver = { sub: new Types.ObjectId().toHexString(), role: 'admin' as const };
const today = accraDay();
const OPENING = '2026-01-01';

/**
 * The identity a balance sheet lives or dies by: assets = liabilities + equity.
 *
 * Every test here asserts `checkDifference === 0` after a different kind of
 * money movement, because each one has to land on both sides of the sheet.
 */
async function expectBalanced(): Promise<void> {
  const sheet = await balanceSheet(today);
  expect(sheet.checkDifference).toBe(0);
  expect(sheet.balances).toBe(true);
  expect(sheet.assets.total).toBe(sheet.liabilities.total + sheet.equity.total);
}

beforeAll(async () => {
  // Opening cash MUST be matched by opening capital or the sheet cannot
  // balance — the cash came from somewhere.
  await cash.createAccount(admin, {
    name: 'Office drawer',
    kind: 'cash-on-hand',
    channel: 'cash',
    openingBalance: 500_000,
    openingDate: OPENING,
  });
  await assets.recordCapital(admin, {
    kind: 'contribution',
    amount: 500_000,
    occurredOn: OPENING,
    note: 'Opening capital',
  });
});

describe('the accounting identity holds', () => {
  it('balances with only opening capital', async () => {
    await expectBalanced();
    const sheet = await balanceSheet(today);
    expect(sheet.assets.current.cashAndBank).toBe(500_000);
    expect(sheet.equity.contributedCapital).toBe(500_000);
    expect(sheet.equity.retainedEarnings).toBe(0);
  });

  it('stays balanced after a susu deposit — cash up, liability up', async () => {
    const customerId = await makeCustomer();
    const account = await susu.openAccount(admin, customerId, 10_000);
    await susu.recordDeposit(admin, new Types.ObjectId(account.id), 10_000, randomUUID(), 'cash');

    const sheet = await balanceSheet(today);
    // The deposit is NOT the company's money — it is owed back.
    expect(sheet.liabilities.customerDeposits.susuBalances).toBe(10_000);
    expect(sheet.assets.current.cashAndBank).toBe(510_000);
    await expectBalanced();
  });

  it('stays balanced after a savings deposit and a fee-bearing withdrawal', async () => {
    const customerId = await makeCustomer();
    const { account } = await savings.openAccount(
      admin,
      customerId,
      100_000,
      undefined,
      'cash',
      'standard',
    );
    const before = await balanceSheet(today);

    // Withdraw GHS 200: the customer gets 20,000 and the balance drops 21,000,
    // the extra 1,000 being the flat fee, which is company income.
    await savings.withdraw(admin, new Types.ObjectId(account.id), 20_000, randomUUID());

    const after = await balanceSheet(today);
    expect(after.assets.current.cashAndBank).toBe(before.assets.current.cashAndBank - 20_000);
    expect(after.liabilities.customerDeposits.savingsBalances).toBe(
      before.liabilities.customerDeposits.savingsBalances - 21_000,
    );
    // The GHS 10 fee lands in retained earnings.
    expect(after.equity.retainedEarnings).toBe(before.equity.retainedEarnings + 1_000);
    await expectBalanced();
  });

  it('stays balanced when an expense is recorded but not yet paid', async () => {
    const before = await balanceSheet(today);
    await expenses.recordExpense(admin, {
      category: 'utilities-premises',
      description: 'August electricity',
      amount: 8_000,
      incurredOn: today,
    });

    const after = await balanceSheet(today);
    // Cash is untouched; the cost sits as a liability and reduces equity.
    expect(after.assets.current.cashAndBank).toBe(before.assets.current.cashAndBank);
    expect(after.liabilities.accruedExpenses).toBe(before.liabilities.accruedExpenses + 8_000);
    expect(after.equity.retainedEarnings).toBe(before.equity.retainedEarnings - 8_000);
    await expectBalanced();
  });

  it('stays balanced when that expense is approved and paid', async () => {
    const recorded = await expenses.recordExpense(admin, {
      category: 'salaries-staff',
      description: 'August salaries',
      amount: 120_000,
      incurredOn: today,
    });
    await expenses.approveExpense(approver, new Types.ObjectId(recorded.id));

    const before = await balanceSheet(today);
    const drawer = await CashAccountModel.findOne({ channel: 'cash' });
    await expenses.payExpense(admin, new Types.ObjectId(recorded.id), {
      cashAccountId: drawer!._id,
      paidOn: today,
    });

    const after = await balanceSheet(today);
    // Payment converts the liability into cash going out. Equity is unchanged:
    // the cost already hit profit when it was incurred.
    expect(after.assets.current.cashAndBank).toBe(before.assets.current.cashAndBank - 120_000);
    expect(after.liabilities.accruedExpenses).toBe(before.liabilities.accruedExpenses - 120_000);
    expect(after.equity.retainedEarnings).toBe(before.equity.retainedEarnings);
    await expectBalanced();
  });

  it('stays balanced when a fixed asset is bought — cash becomes an asset', async () => {
    const drawer = await CashAccountModel.findOne({ channel: 'cash' });
    const before = await balanceSheet(today);

    await assets.registerAsset(admin, {
      name: 'Collector motorbike',
      category: 'motorbike-vehicle',
      cost: 120_000,
      acquiredOn: today,
      usefulLifeMonths: 48,
      salvageValue: 0,
      cashAccountId: drawer!._id,
    });

    const after = await balanceSheet(today);
    expect(after.assets.current.cashAndBank).toBe(before.assets.current.cashAndBank - 120_000);
    // Bought today, so no month has elapsed and nothing has depreciated yet.
    expect(after.assets.nonCurrent.netBookValue).toBe(
      before.assets.nonCurrent.netBookValue + 120_000,
    );
    expect(after.assets.total).toBe(before.assets.total);
    await expectBalanced();
  });

  it('stays balanced after a drawing — equity down, cash down', async () => {
    const drawer = await CashAccountModel.findOne({ channel: 'cash' });
    const before = await balanceSheet(today);

    await assets.recordCapital(admin, {
      kind: 'drawing',
      amount: 30_000,
      occurredOn: today,
      cashAccountId: drawer!._id,
    });

    const after = await balanceSheet(today);
    expect(after.assets.current.cashAndBank).toBe(before.assets.current.cashAndBank - 30_000);
    expect(after.equity.drawings).toBe(before.equity.drawings + 30_000);
    expect(after.equity.total).toBe(before.equity.total - 30_000);
    await expectBalanced();
  });
});

describe('what the sheet refuses to overstate', () => {
  it('never counts customer deposits as company wealth', async () => {
    const sheet = await balanceSheet(today);
    expect(sheet.liabilities.customerDeposits.total).toBeGreaterThan(0);
    // Deposits are on the liability side only — they are not in equity.
    expect(sheet.equity.total).toBeLessThan(sheet.assets.total);
  });

  it('shows loans at principal and discloses uncollected interest separately', async () => {
    const sheet = await balanceSheet(today);
    expect(sheet.disclosures).toHaveProperty('unearnedLoanInterest');
    expect(sheet.disclosures.note).toContain('recognised as it is repaid');
  });
});

describe('profit and loss agrees with the balance sheet', () => {
  it('ties retained earnings to all-time net profit', async () => {
    const sheet = await balanceSheet(today);
    const allTime = await profitAndLoss('2020-01-01', today);
    expect(sheet.equity.retainedEarnings).toBe(allTime.netProfit);
  });

  it('reports expenses under the category they were recorded against', async () => {
    const pl = await profitAndLoss('2020-01-01', today);
    const categories = pl.expenses.byCategory.map((c) => c.category);
    expect(categories).toContain('salaries-staff');
    expect(categories).toContain('utilities-premises');
    expect(pl.expenses.total).toBe(pl.expenses.recorded + pl.expenses.depreciation);
  });
});
