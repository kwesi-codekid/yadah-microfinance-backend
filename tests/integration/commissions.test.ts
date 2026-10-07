import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CashAccountModel, CommissionModel } from '../../src/models/index.js';
import * as cash from '../../src/modules/accounting/cash.service.js';
import { backfillCommissions } from '../../src/modules/commissions/commissions.backfill.js';
import * as commissions from '../../src/modules/commissions/commissions.service.js';
import * as loans from '../../src/modules/loans/loans.service.js';
import * as savings from '../../src/modules/savings/savings.service.js';
import { accraDay } from '../../src/lib/time.js';
import { asOfficer, makeCustomer, makeGuarantor, setupDb, teardownDb } from './helpers.js';

/**
 * Yadah's commission account (client decisions, 7 Oct 2026): susu commission,
 * savings fees and loan processing fees in one ledger, held apart from the
 * cash accounts until office staff move it into one.
 */

const officer = asOfficer();
let guarantor: Types.ObjectId;
let drawer: Types.ObjectId;

beforeAll(async () => {
  await setupDb();
  guarantor = await makeGuarantor();
  const existing = await CashAccountModel.findOne({ channel: 'cash', status: 'active' });
  drawer =
    existing?._id ??
    new Types.ObjectId(
      (
        await cash.createAccount(officer, {
          name: 'Office drawer',
          kind: 'cash-on-hand',
          channel: 'cash',
          openingBalance: 0,
          openingDate: '2026-01-01',
        })
      ).id,
    );
});
afterAll(teardownDb);

/** A savings account with `amount` deposited in cash, and one withdrawal of `out`. */
async function savingsWithWithdrawal(amount: number, out: number) {
  const customerId = await makeCustomer();
  const { account } = await savings.openAccount(officer, customerId, amount, randomUUID(), 'cash');
  const accountId = new Types.ObjectId(account.id);
  const w = await savings.withdraw(officer, accountId, out, randomUUID());
  return { customerId, accountId, txnId: new Types.ObjectId(w.txn.id) };
}

async function drawerBalance(): Promise<number> {
  const account = await CashAccountModel.findById(drawer);
  return (await cash.accountBalance(account!)).balance;
}

describe('every source files into one account', () => {
  it('a savings withdrawal fee is an entry; trashing the withdrawal takes it back', async () => {
    const { accountId, txnId } = await savingsWithWithdrawal(10_000, 2_000);
    const entry = await CommissionModel.findOne({ savingsTxnId: txnId });
    expect(entry).toMatchObject({
      source: 'savings-fee',
      reason: 'savings-withdrawal',
      amount: 1_000,
      channel: 'cash',
    });
    expect(entry?.accountId.equals(accountId)).toBe(true);

    await savings.trashSavingsTxn(officer, accountId, txnId, 'wrong account');
    expect(await CommissionModel.countDocuments({ savingsTxnId: txnId })).toBe(0);
    await savings.restoreSavingsTxn(officer, accountId, txnId);
    expect(await CommissionModel.countDocuments({ savingsTxnId: txnId })).toBe(1);
  });

  it('a loan processing fee is an entry the day the loan goes out', async () => {
    const customerId = await makeCustomer(true);
    const applied = await loans.applyForLoan(
      officer,
      customerId,
      100_000,
      3,
      guarantor,
      undefined,
      undefined,
      { processingFee: 5_000 },
    );
    const loanId = new Types.ObjectId(applied.id);
    expect(await CommissionModel.countDocuments({ accountId: loanId })).toBe(0);

    await loans.approveLoan(officer, loanId);
    const entry = await CommissionModel.findOne({ accountId: loanId });
    expect(entry).toMatchObject({ source: 'loan-fee', reason: 'loan-disbursed', amount: 5_000 });
  });

  it('lists by source with totals for every source, and searches by account number', async () => {
    const { accountId } = await savingsWithWithdrawal(20_000, 3_000);
    const all = await commissions.listCommissions({ page: 1, limit: 100 });
    const onlySavings = await commissions.listCommissions({
      page: 1,
      limit: 100,
      source: 'savings-fee',
    });
    expect(onlySavings.items.every((i) => i.source === 'savings-fee')).toBe(true);
    expect(onlySavings.totals.bySource).toEqual(all.totals.bySource);
    expect(onlySavings.totals.amount).toBe(all.totals.bySource['savings-fee']);

    const account = await savings.getAccount(officer, accountId);
    const found = await commissions.listCommissions({
      page: 1,
      limit: 10,
      q: account.accountNumber,
    });
    expect(found.items).toHaveLength(1);
    expect(found.items[0]).toMatchObject({ amount: 1_000, accountNumber: account.accountNumber });
  });
});

describe('moving commission to a cash account', () => {
  it('the fee leaves the drawer figure for the commission account; a move brings it back', async () => {
    const drawerBefore = await drawerBalance();
    const potBefore = (await commissions.summary()).balance;
    const totalBefore = (await cash.cashPosition()).total;

    await savingsWithWithdrawal(10_000, 2_000);
    // 10,000 in, 2,000 handed over, 1,000 fee held by the commission account.
    expect((await drawerBalance()) - drawerBefore).toBe(10_000 - 2_000 - 1_000);
    expect((await commissions.summary()).balance - potBefore).toBe(1_000);
    expect((await cash.cashPosition()).total - totalBefore).toBe(10_000 - 2_000);

    const totalMid = (await cash.cashPosition()).total;
    const drawerMid = await drawerBalance();
    const r = await commissions.createMove(officer, {
      amount: 600,
      cashAccountId: drawer,
      idempotencyKey: randomUUID(),
    });
    expect(r.replayed).toBe(false);
    expect(r.move).toMatchObject({
      amount: 600,
      occurredOn: accraDay(),
      cashAccountName: 'Office drawer',
    });
    expect((await drawerBalance()) - drawerMid).toBe(600);
    // Money moved between Yadah's own pockets: the total does not change.
    expect((await cash.cashPosition()).total).toBe(totalMid);

    // Undo: back in the commission account, out of the drawer.
    const undone = await commissions.trashMove(officer, new Types.ObjectId(r.move.id), 'wrong');
    expect(undone.balance).toBe(r.balance + 600);
    expect(await drawerBalance()).toBe(drawerMid);
  });

  it('never more than the account holds, and replays under the same key', async () => {
    const { balance } = await commissions.summary();
    await expect(
      commissions.createMove(officer, {
        amount: balance + 1,
        cashAccountId: drawer,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'EXCEEDS_BALANCE', status: 422, details: { balance } });

    const key = randomUUID();
    const first = await commissions.createMove(officer, {
      amount: 100,
      cashAccountId: drawer,
      idempotencyKey: key,
    });
    const again = await commissions.createMove(officer, {
      amount: 100,
      cashAccountId: drawer,
      idempotencyKey: key,
    });
    expect(again.replayed).toBe(true);
    expect(again.move.id).toBe(first.move.id);
    expect((await commissions.summary()).balance).toBe(balance - 100);
  });

  it('two moves at once cannot overdraw it', async () => {
    const { balance } = await commissions.summary();
    const half = Math.floor(balance / 2) + 1;
    const results = await Promise.allSettled(
      [0, 1].map(() =>
        commissions.createMove(officer, {
          amount: half,
          cashAccountId: drawer,
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await commissions.summary()).balance).toBe(balance - half);
  });
});

describe('the backfill', () => {
  it('files savings fees and loan fees that have no entry yet, once', async () => {
    const { txnId } = await savingsWithWithdrawal(10_000, 1_000);
    await CommissionModel.deleteMany({ savingsTxnId: txnId });

    const dry = await backfillCommissions(false);
    expect(dry.savings.entries).toBeGreaterThanOrEqual(1);
    expect(await CommissionModel.countDocuments({ savingsTxnId: txnId })).toBe(0);

    await backfillCommissions(true);
    expect(await CommissionModel.countDocuments({ savingsTxnId: txnId })).toBe(1);
    expect((await backfillCommissions(true)).entries).toBe(0);
  });
});
