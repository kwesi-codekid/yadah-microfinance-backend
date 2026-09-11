import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CashAccountModel, ExpenseModel } from '../../src/models/index.js';
import * as expenses from '../../src/modules/expenses/expenses.service.js';
import { asOfficer, CLOUDINARY, makeTeller, setupDb, teardownDb } from './helpers.js';

/**
 * The expense book as its own module: the counter records, the office decides
 * and pays, and nobody approves their own spending.
 */

const officer = asOfficer();
const secondOfficer = asOfficer();
let teller: Awaited<ReturnType<typeof makeTeller>>;
let cashAccountId: Types.ObjectId;

beforeAll(async () => {
  await setupDb();
  teller = await makeTeller('Counter Clerk');
  const account = await CashAccountModel.create({
    name: 'Cash on hand',
    kind: 'cash-on-hand',
    channel: 'cash',
    openingBalance: 0,
    openingDate: new Date('2026-01-01T00:00:00.000Z'),
    createdById: new Types.ObjectId(officer.sub),
  });
  cashAccountId = account._id;
});
afterAll(teardownDb);

async function record(amount = 5_000, by = teller) {
  return expenses.recordExpense(by, {
    category: 'petty-cash-office',
    description: 'Cleaning supplies for the branch',
    amount,
    incurredOn: '2026-09-01',
  });
}

describe('recording', () => {
  it('lets the counter record petty cash, and moves no money doing it', async () => {
    const expense = await record();
    expect(expense.status).toBe('pending');
    expect(expense.recordedById).toBe(teller.sub);
    expect(expense.recordedByName).toBe('Counter Clerk');
    // Recording is not paying: no account is named until payment.
    expect(expense.cashAccountId).toBeUndefined();
    expect(expense.paidOn).toBeUndefined();
  });

  it('corrects a pending entry, and refuses once it has been approved', async () => {
    const expense = await record(8_000);
    const fixed = await expenses.updateExpense(teller, new Types.ObjectId(expense.id), {
      amount: 8_500,
    });
    expect(fixed.amount).toBe(8_500);

    await expenses.approveExpense(officer, new Types.ObjectId(expense.id));
    await expect(
      expenses.updateExpense(teller, new Types.ObjectId(expense.id), { amount: 9_000 }),
    ).rejects.toMatchObject({ code: 'NOT_PENDING' });
  });

  it('attaches a receipt photo at any point, including after approval', async () => {
    const expense = await record();
    const url = `${CLOUDINARY}/receipt-1.jpg`;
    const withReceipt = await expenses.attachReceipt(teller, new Types.ObjectId(expense.id), {
      receiptUrl: url,
    });
    expect(withReceipt.receiptUrl).toBe(url);

    await expenses.approveExpense(officer, new Types.ObjectId(expense.id));
    // A receipt turning up late is the ordinary case, not an error.
    const replaced = await expenses.attachReceipt(officer, new Types.ObjectId(expense.id), {
      receiptUrl: `${CLOUDINARY}/receipt-2.jpg`,
    });
    expect(replaced.receiptUrl).toBe(`${CLOUDINARY}/receipt-2.jpg`);
  });
});

describe('deciding and paying', () => {
  it('will not let the recorder approve their own spending', async () => {
    const expense = await record(12_000, officer);
    await expect(
      expenses.approveExpense(officer, new Types.ObjectId(expense.id)),
    ).rejects.toMatchObject({ code: 'SELF_APPROVAL' });

    // Somebody else can.
    const approved = await expenses.approveExpense(secondOfficer, new Types.ObjectId(expense.id));
    expect(approved.status).toBe('approved');
  });

  it('pays only an approved expense, and only then names an account', async () => {
    const expense = await record(7_000);
    await expect(
      expenses.payExpense(officer, new Types.ObjectId(expense.id), { cashAccountId }),
    ).rejects.toMatchObject({ code: 'NOT_APPROVED' });

    await expenses.approveExpense(officer, new Types.ObjectId(expense.id));
    const paid = await expenses.payExpense(officer, new Types.ObjectId(expense.id), {
      cashAccountId,
      paidOn: '2026-09-10',
    });
    expect(paid.status).toBe('paid');
    expect(paid.cashAccountId).toBe(cashAccountId.toHexString());
    expect(paid.paidOn).toBe('2026-09-10');
    // The cost still belongs to the day it was incurred, not the day it was settled.
    expect(paid.incurredOn).toBe('2026-09-01');

    await expect(
      expenses.payExpense(officer, new Types.ObjectId(expense.id), { cashAccountId }),
    ).rejects.toMatchObject({ code: 'ALREADY_PAID' });
  });

  it('records why an expense was refused', async () => {
    const expense = await record();
    const rejected = await expenses.rejectExpense(
      officer,
      new Types.ObjectId(expense.id),
      'Personal, not a branch cost',
    );
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectionReason).toBe('Personal, not a branch cost');
  });
});

describe('the summary', () => {
  it('totals what was spent by category, leaving rejected costs out', async () => {
    await ExpenseModel.deleteMany({});

    await expenses.recordExpense(teller, {
      category: 'utilities-premises',
      description: 'Electricity',
      amount: 40_000,
      incurredOn: '2026-09-03',
    });
    await expenses.recordExpense(teller, {
      category: 'utilities-premises',
      description: 'Water',
      amount: 10_000,
      incurredOn: '2026-09-04',
    });
    await expenses.recordExpense(teller, {
      category: 'marketing',
      description: 'Radio advert',
      amount: 25_000,
      incurredOn: '2026-09-05',
    });
    const refused = await expenses.recordExpense(teller, {
      category: 'marketing',
      description: 'Not ours',
      amount: 90_000,
      incurredOn: '2026-09-06',
    });
    await expenses.rejectExpense(officer, new Types.ObjectId(refused.id), 'not ours');

    const summary = await expenses.expenseSummary({ from: '2026-09-01', to: '2026-09-30' });
    expect(summary.totalAmount).toBe(75_000);
    expect(summary.totalCount).toBe(3);
    expect(summary.byCategory[0]).toEqual({
      category: 'utilities-premises',
      count: 2,
      amount: 50_000,
    });
    // Nothing has been paid, so all of it is still owed.
    expect(summary.outstandingAmount).toBe(75_000);
    // The rejected one is still counted in the status breakdown.
    expect(summary.byStatus.find((s) => s.status === 'rejected')).toEqual({
      status: 'rejected',
      count: 1,
      amount: 90_000,
    });
  });

  it('only counts the period asked for', async () => {
    await ExpenseModel.deleteMany({});
    await expenses.recordExpense(teller, {
      category: 'marketing',
      description: 'August flyers',
      amount: 15_000,
      incurredOn: '2026-08-20',
    });
    await expenses.recordExpense(teller, {
      category: 'marketing',
      description: 'September flyers',
      amount: 20_000,
      incurredOn: '2026-09-20',
    });

    const september = await expenses.expenseSummary({ from: '2026-09-01', to: '2026-09-30' });
    expect(september.totalAmount).toBe(20_000);
    const both = await expenses.expenseSummary({});
    expect(both.totalAmount).toBe(35_000);
  });
});

describe('the bin', () => {
  it('bins a pending expense and restores it', async () => {
    const expense = await record();
    const binned = await expenses.trashExpense(
      officer,
      new Types.ObjectId(expense.id),
      'duplicate',
    );
    expect(binned.deletedAt).toBeInstanceOf(Date);

    const trash = await expenses.listExpenseTrash({ page: 1, limit: 25 });
    expect(trash.items.map((e) => e.id)).toContain(expense.id);

    const restored = await expenses.restoreExpense(officer, new Types.ObjectId(expense.id));
    expect(restored.status).toBe('pending');
  });

  it('keeps an approved or paid expense on the books', async () => {
    const approvedOne = await record();
    await expenses.approveExpense(officer, new Types.ObjectId(approvedOne.id));
    await expect(
      expenses.trashExpense(officer, new Types.ObjectId(approvedOne.id), 'tidying'),
    ).rejects.toMatchObject({ code: 'CANNOT_TRASH' });

    const paidOne = await record();
    await expenses.approveExpense(officer, new Types.ObjectId(paidOne.id));
    await expenses.payExpense(officer, new Types.ObjectId(paidOne.id), { cashAccountId });
    await expect(
      expenses.trashExpense(officer, new Types.ObjectId(paidOne.id), 'tidying'),
    ).rejects.toMatchObject({ code: 'CANNOT_TRASH' });
  });
});
