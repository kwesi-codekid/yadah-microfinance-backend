import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import {
  CommissionModel,
  HpItemModel,
  LoanModel,
  RepaymentModel,
  SavingsAccountModel,
  SavingsTxnModel,
  SusuAccountModel,
  SusuDepositModel,
} from '../../src/models/index.js';
import * as corrections from '../../src/modules/corrections/corrections.service.js';
import * as customers from '../../src/modules/customers/customers.service.js';
import * as hp from '../../src/modules/hire-purchase/hp.service.js';
import * as loans from '../../src/modules/loans/loans.service.js';
import * as savings from '../../src/modules/savings/savings.service.js';
import * as susu from '../../src/modules/susu/susu.service.js';
import {
  asOfficer,
  makeCustomer,
  makeGuarantor,
  makeTeller,
  setupDb,
  teardownDb,
} from './helpers.js';

/** Stands behind every application in this file. One is enough: the rule is
 *  about who the guarantor is, not how many loans they carry. */
let guarantor: Types.ObjectId;
beforeAll(async () => {
  await setupDb();
  guarantor = await makeGuarantor();
});
afterAll(teardownDb);

const officer = asOfficer();

/** Customer with 4 months of backdated susu history (HP eligibility). */
async function makeEligibleCustomer(): Promise<Types.ObjectId> {
  const customerId = await makeCustomer();
  const { account } = await susu.openAccount(officer, customerId, 1_000);
  await susu.recordDeposit(
    officer,
    new Types.ObjectId(account.id),
    5_000,
    randomUUID(),
    'cash',
    undefined,
    undefined,
    [{ planId: account.plans[0]!.id, payments: 5 }],
  );
  await SusuDepositModel.updateMany(
    { customerId },
    { $set: { createdAt: new Date(Date.now() - 130 * 24 * 60 * 60 * 1000) } },
    { timestamps: false, overwriteImmutable: true },
  );
  return customerId;
}

async function makeItem(stock: number): Promise<Types.ObjectId> {
  const item = await hp.createItem(officer, {
    name: `Trash Test Item ${randomUUID().slice(0, 8)}`,
    quantityInStock: stock,
    costPrice: 100_000,
    sellingPrice: 200_000,
  });
  return new Types.ObjectId(item.id);
}

describe('customer trash', () => {
  it('blocks trash while products are open, allows after they end, restores round-trip', async () => {
    const customerId = await makeCustomer();
    const { account } = await susu.openAccount(officer, customerId, 1_000);
    const accountId = new Types.ObjectId(account.id);

    await expect(customers.trashCustomer(officer, customerId, undefined)).rejects.toMatchObject({
      code: 'CANNOT_TRASH',
    });

    await susu.closeAccount(officer, accountId);
    const trashed = await customers.trashCustomer(officer, customerId, 'duplicate entry');
    expect(trashed.deleteReason).toBe('duplicate entry');

    await expect(customers.getCustomer(officer, customerId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const trashList = await customers.listCustomerTrash(officer, { page: 1, limit: 50 });
    expect(trashList.items.some((c) => c.id === customerId.toHexString())).toBe(true);

    await customers.restoreCustomer(officer, customerId);
    const restored = await customers.getCustomer(officer, customerId);
    expect(restored.id).toBe(customerId.toHexString());
  });
});

describe('susu account trash', () => {
  it('only pristine accounts can be trashed; trashed accounts vanish from normal endpoints', async () => {
    const usedCustomer = await makeCustomer();
    const { account: used } = await susu.openAccount(officer, usedCustomer, 1_000);
    await susu.recordDeposit(officer, new Types.ObjectId(used.id), 1_000, randomUUID(), 'cash');
    await expect(
      susu.trashSusuAccount(officer, new Types.ObjectId(used.id), undefined),
    ).rejects.toMatchObject({ code: 'CANNOT_TRASH' });

    const customerId = await makeCustomer();
    const { account: pristine } = await susu.openAccount(officer, customerId, 2_000);
    const pristineId = new Types.ObjectId(pristine.id);
    await susu.trashSusuAccount(officer, pristineId, 'opened by mistake');

    await expect(susu.getAccount(officer, pristineId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      susu.recordDeposit(officer, pristineId, 2_000, randomUUID(), 'cash'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const list = await susu.listAccounts(officer, { page: 1, limit: 100, customerId });
    expect(list.items.some((a) => a.id === pristine.id)).toBe(false);

    // A trashed account does not block the customer's real one.
    const { account: replacement } = await susu.openAccount(officer, customerId, 3_000);
    expect(replacement.id).not.toBe(pristine.id);
    // …and the trashed one cannot come back while it stands.
    await expect(susu.restoreSusuAccount(officer, pristineId)).rejects.toMatchObject({
      code: 'CANNOT_RESTORE',
    });
    await susu.trashSusuAccount(officer, new Types.ObjectId(replacement.id), undefined);

    await susu.restoreSusuAccount(officer, pristineId);
    const result = await susu.recordDeposit(officer, pristineId, 2_000, randomUUID(), 'cash');
    expect(result.account.plans[0]?.paidInCycle).toBe(1);
  });

  it('restore of a live account reports NOT_TRASHED', async () => {
    const customerId = await makeCustomer();
    const { account } = await susu.openAccount(officer, customerId, 1_000);
    await expect(
      susu.restoreSusuAccount(officer, new Types.ObjectId(account.id)),
    ).rejects.toMatchObject({ code: 'NOT_TRASHED' });
  });
});

describe('savings account trash', () => {
  it('a pristine account trashes and is gone from the book', async () => {
    const customerId = await makeCustomer();
    const pristine = await savings.openAccount(officer, customerId, undefined, undefined, 'cash');
    const pristineId = new Types.ObjectId(pristine.account.id);
    await savings.trashSavingsAccount(officer, pristineId, undefined);
    await expect(savings.getAccount(officer, pristineId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('a funded account trashes with its transactions and restores intact', async () => {
    const customerId = await makeCustomer();
    const opened = await savings.openAccount(officer, customerId, 20_000, randomUUID(), 'cash');
    const accountId = new Types.ObjectId(opened.account.id);
    await savings.withdraw(officer, accountId, 2_000, randomUUID()); // fee → commission
    expect(await CommissionModel.countDocuments({ source: 'savings-fee' })).toBeGreaterThan(0);
    const feesBefore = await CommissionModel.countDocuments({ source: 'savings-fee' });

    await savings.trashSavingsAccount(officer, accountId, 'opened for the wrong person');
    // Gone from the book, and every transaction went with it.
    await expect(savings.getAccount(officer, accountId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await SavingsTxnModel.countDocuments({ accountId, deletedAt: null })).toBe(0);
    // The withdrawal fee left the commission account.
    expect(await CommissionModel.countDocuments({ source: 'savings-fee' })).toBe(feesBefore - 1);

    await savings.restoreSavingsAccount(officer, accountId);
    const back = await savings.getAccount(officer, accountId);
    expect(back.balance).toBe(opened.account.balance - 2_000 - 1_000); // 20k − 2k − 10 fee
    expect(await SavingsTxnModel.countDocuments({ accountId, deletedAt: null })).toBe(2);
    expect(await CommissionModel.countDocuments({ source: 'savings-fee' })).toBe(feesBefore);
  });
});

describe('loan trash', () => {
  it('trashed pending loan frees the one-open-loan slot; restore re-checks it', async () => {
    const customerId = await makeCustomer(true);
    const first = await loans.applyForLoan(officer, customerId, 100_000, 3, guarantor);
    const firstId = new Types.ObjectId(first.id);

    await expect(
      loans.applyForLoan(officer, customerId, 200_000, 3, guarantor),
    ).rejects.toMatchObject({
      code: 'LOAN_EXISTS',
    });

    await loans.trashLoan(officer, firstId, 'entered wrong amount');
    const second = await loans.applyForLoan(officer, customerId, 200_000, 3, guarantor);
    expect(second.status).toBe('pending');

    await expect(loans.restoreLoan(officer, firstId)).rejects.toMatchObject({
      code: 'LOAN_EXISTS',
    });
  });

  it('an active loan is deleted with its money: fee out, repayments out, accounts refunded', async () => {
    const customerId = await makeCustomer(true);
    const { account: susuAccount } = await susu.openAccount(officer, customerId, 2_000);
    const susuId = new Types.ObjectId(susuAccount.id);
    await susu.recordDeposit(officer, susuId, 20_000, randomUUID(), 'cash', undefined, undefined, [
      { planId: susuAccount.plans[0]!.id, payments: 10 },
    ]);
    const { account: loanSavings } = await savings.openAccount(
      officer,
      customerId,
      30_000,
      randomUUID(),
      'cash',
      'loan',
    );
    const loanSavingsId = new Types.ObjectId(loanSavings.id);

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
    await loans.approveLoan(officer, loanId);
    await loans.repayCash(officer, loanId, 5_000, randomUUID(), 'cash');
    await loans.repayFromSusu(officer, loanId, susuId, 10_000, randomUUID());
    await loans.repayFromLoanSavings(officer, loanId, 20_000, randomUUID());
    expect((await SusuAccountModel.findById(susuId))?.balance).toBe(10_000);
    expect(await CommissionModel.countDocuments({ source: 'loan-fee', accountId: loanId })).toBe(1);

    const trashed = await loans.trashLoan(officer, loanId, 'wrong customer');
    expect(trashed.deleteReason).toBe('wrong customer');

    const repayments = await RepaymentModel.find({ loanId });
    expect(repayments).toHaveLength(3);
    expect(repayments.every((r) => r.deletedAt)).toBe(true);
    expect(await CommissionModel.countDocuments({ source: 'loan-fee', accountId: loanId })).toBe(0);
    // Susu gets its 10,000 back as five whole rounds; loan savings its 20,000.
    expect((await SusuAccountModel.findById(susuId))?.balance).toBe(20_000);
    expect((await SavingsAccountModel.findById(loanSavingsId))?.balance).toBe(30_000);

    await expect(loans.restoreLoan(officer, loanId)).rejects.toMatchObject({
      code: 'CANNOT_RESTORE',
    });
    // The one-open-loan slot is free again.
    const again = await loans.applyForLoan(officer, customerId, 100_000, 3, guarantor);
    expect(again.status).toBe('pending');
  });

  it('refuses, touching nothing, when a susu repayment is too small to go back', async () => {
    const customerId = await makeCustomer(true);
    const { account: susuAccount } = await susu.openAccount(officer, customerId, 2_000);
    const susuId = new Types.ObjectId(susuAccount.id);
    await susu.recordDeposit(officer, susuId, 20_000, randomUUID(), 'cash', undefined, undefined, [
      { planId: susuAccount.plans[0]!.id, payments: 10 },
    ]);
    const applied = await loans.applyForLoan(officer, customerId, 100_000, 3, guarantor);
    const loanId = new Types.ObjectId(applied.id);
    await loans.approveLoan(officer, loanId);
    await loans.repayFromSusu(officer, loanId, susuId, 1_500, randomUUID());

    await expect(loans.trashLoan(officer, loanId, undefined)).rejects.toMatchObject({
      code: 'CANNOT_TRASH',
    });
    expect((await LoanModel.findById(loanId))?.deletedAt).toBeNull();
    expect((await RepaymentModel.findOne({ loanId }))?.deletedAt).toBeNull();
    expect((await SusuAccountModel.findById(susuId))?.balance).toBe(18_500);
  });
});

describe('single repayment delete', () => {
  it('removes any repayment, refunds its source, and reopens a settled loan', async () => {
    const customerId = await makeCustomer(true);
    const { account: loanSavings } = await savings.openAccount(
      officer,
      customerId,
      60_000,
      randomUUID(),
      'cash',
      'loan',
    );
    const loanSavingsId = new Types.ObjectId(loanSavings.id);
    const applied = await loans.applyForLoan(officer, customerId, 100_000, 3, guarantor);
    const loanId = new Types.ObjectId(applied.id);
    await loans.approveLoan(officer, loanId); // totalDue 110,000

    const first = await loans.repayFromLoanSavings(officer, loanId, 40_000, randomUUID());
    await loans.repayCash(officer, loanId, 70_000, randomUUID(), 'cash'); // settles → repaid
    expect((await LoanModel.findById(loanId))?.status).toBe('repaid');
    expect((await SavingsAccountModel.findById(loanSavingsId))?.balance).toBe(20_000);

    // Delete the FIRST (not newest) repayment: its 40,000 goes back to loan
    // savings, the loan reopens, and only two repayments remain live.
    const { loan } = await loans.trashRepayment(
      officer,
      loanId,
      new Types.ObjectId(first.repayment.id),
      'wrong account',
    );
    expect(loan.status).toBe('active');
    expect(loan.totalRepaid).toBe(70_000);
    expect((await SavingsAccountModel.findById(loanSavingsId))?.balance).toBe(60_000);
    const live = await RepaymentModel.find({ loanId, deletedAt: null });
    expect(live).toHaveLength(1);
    expect((await RepaymentModel.findById(first.repayment.id))?.deletedAt).toBeTruthy();
  });

  it('refuses while a correction request is pending on the repayment', async () => {
    const customerId = await makeCustomer(true);
    const applied = await loans.applyForLoan(officer, customerId, 100_000, 3, guarantor);
    const loanId = new Types.ObjectId(applied.id);
    await loans.approveLoan(officer, loanId);
    const rep = await loans.repayCash(officer, loanId, 30_000, randomUUID(), 'cash');
    const repaymentId = new Types.ObjectId(rep.repayment.id);

    const teller = await makeTeller();
    await corrections.propose(teller, 'loan-repayment', loanId, repaymentId, {
      amount: 25_000,
      reason: 'typo',
    });

    await expect(
      loans.trashRepayment(officer, loanId, repaymentId, undefined),
    ).rejects.toMatchObject({ code: 'CANNOT_TRASH' });
    expect((await RepaymentModel.findById(repaymentId))?.deletedAt).toBeNull();
  });
});

describe('hire purchase trash', () => {
  it('trashing a pending agreement restocks the item; restore takes the stock back', async () => {
    const customerId = await makeEligibleCustomer();
    const itemId = await makeItem(1);
    const agreement = await hp.createAgreement(officer, {
      customerId,
      itemId,
      agreedPrice: 200_000,
      durationMonths: 6,
    });
    const agreementId = new Types.ObjectId(agreement.id);
    expect((await HpItemModel.findById(itemId))?.quantityInStock).toBe(0);

    await hp.trashHpAgreement(officer, agreementId, undefined);
    expect((await HpItemModel.findById(itemId))?.quantityInStock).toBe(1);

    await hp.restoreHpAgreement(officer, agreementId);
    expect((await HpItemModel.findById(itemId))?.quantityInStock).toBe(0);
  });

  it('restore fails with OUT_OF_STOCK when the freed unit was sold meanwhile', async () => {
    const [c1, c2] = await Promise.all([makeEligibleCustomer(), makeEligibleCustomer()]);
    const itemId = await makeItem(1);
    const first = await hp.createAgreement(officer, {
      customerId: c1,
      itemId,
      agreedPrice: 200_000,
      durationMonths: 6,
    });
    await hp.trashHpAgreement(officer, new Types.ObjectId(first.id), undefined);

    await hp.createAgreement(officer, {
      customerId: c2,
      itemId,
      agreedPrice: 200_000,
      durationMonths: 6,
    });
    await expect(
      hp.restoreHpAgreement(officer, new Types.ObjectId(first.id)),
    ).rejects.toMatchObject({ code: 'OUT_OF_STOCK' });
  });

  it('items referenced by any agreement cannot be trashed; unused items can', async () => {
    const customerId = await makeEligibleCustomer();
    const usedItemId = await makeItem(2);
    await hp.createAgreement(officer, {
      customerId,
      itemId: usedItemId,
      agreedPrice: 200_000,
      durationMonths: 6,
    });
    await expect(hp.trashHpItem(officer, usedItemId, undefined)).rejects.toMatchObject({
      code: 'CANNOT_TRASH',
    });

    const freshItemId = await makeItem(3);
    await hp.trashHpItem(officer, freshItemId, 'created by mistake');
    const list = await hp.listItems(officer, { page: 1, limit: 100, inStockOnly: false });
    expect(list.items.some((i) => i.id === freshItemId.toHexString())).toBe(false);
  });
});

describe('susu deposit trash and correction', () => {
  it('trashing the latest deposit un-credits the plan and undoes a completed cycle', async () => {
    const customerId = await makeCustomer();
    const { account } = await susu.openAccount(officer, customerId, 1_000);
    const accountId = new Types.ObjectId(account.id);
    await susu.recordDeposit(
      officer,
      accountId,
      30_000,
      randomUUID(),
      'cash',
      undefined,
      undefined,
      [{ planId: account.plans[0]!.id, payments: 30 }],
    );
    const last = await susu.recordDeposit(officer, accountId, 1_000, randomUUID(), 'cash');
    expect(last.account.plans[0]?.cyclesCompleted).toBe(1);
    const depositId = new Types.ObjectId(last.deposit.id);

    const trashed = await susu.trashDeposit(officer, accountId, depositId, 'entry error');
    expect(trashed.account.plans[0]).toMatchObject({ paidInCycle: 30, cyclesCompleted: 0 });
    expect(trashed.account.balance).toBe(30_000);

    const restored = await susu.restoreDeposit(officer, accountId, depositId);
    expect(restored.account.plans[0]).toMatchObject({ paidInCycle: 0, cyclesCompleted: 1 });
    expect(restored.account.balance).toBe(30_000);
  });

  it('only the latest deposit can be trashed; replays of trashed keys are refused', async () => {
    const customerId = await makeCustomer();
    const { account } = await susu.openAccount(officer, customerId, 1_000);
    const accountId = new Types.ObjectId(account.id);
    const key = randomUUID();
    const first = await susu.recordDeposit(officer, accountId, 1_000, key, 'cash');
    const second = await susu.recordDeposit(officer, accountId, 1_000, randomUUID(), 'cash');

    await expect(
      susu.trashDeposit(officer, accountId, new Types.ObjectId(first.deposit.id), undefined),
    ).rejects.toMatchObject({ code: 'CANNOT_TRASH' });

    await susu.trashDeposit(officer, accountId, new Types.ObjectId(second.deposit.id), undefined);
    await susu.trashDeposit(officer, accountId, new Types.ObjectId(first.deposit.id), undefined);
    await expect(susu.recordDeposit(officer, accountId, 1_000, key, 'cash')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('PATCH corrects the latest deposit amount and adjusts the plan and balance', async () => {
    const customerId = await makeCustomer();
    const { account } = await susu.openAccount(officer, customerId, 1_000);
    const accountId = new Types.ObjectId(account.id);
    const rec = await susu.recordDeposit(
      officer,
      accountId,
      3_000,
      randomUUID(),
      'cash',
      undefined,
      undefined,
      [{ planId: account.plans[0]!.id, payments: 3 }],
    );
    const depositId = new Types.ObjectId(rec.deposit.id);

    const updated = await susu.updateDeposit(officer, accountId, depositId, 1_000);
    expect(updated.deposit.payments).toBe(1);
    expect(updated.deposit.lines[0]?.seqEnd).toBe(1);
    expect(updated.account.plans[0]?.paidInCycle).toBe(1);
    expect((await SusuAccountModel.findById(accountId))?.balance).toBe(1_000);
  });
});

describe('savings txn trash', () => {
  it('trashing a withdrawal refunds amount+fee and frees the daily slot', async () => {
    const customerId = await makeCustomer();
    const opened = await savings.openAccount(officer, customerId, 20_000, randomUUID(), 'cash');
    const accountId = new Types.ObjectId(opened.account.id);
    const wd = await savings.withdraw(officer, accountId, 2_000, randomUUID());
    const txnId = new Types.ObjectId(wd.txn.id);

    await expect(savings.withdraw(officer, accountId, 1_000, randomUUID())).rejects.toMatchObject({
      code: 'WITHDRAWAL_LIMIT',
    });

    const trashed = await savings.trashSavingsTxn(officer, accountId, txnId, 'wrong amount');
    expect(trashed.account.balance).toBe(20_000); // amount + GHS 10 fee refunded

    // Day freed: a corrected withdrawal can now be recorded.
    const redo = await savings.withdraw(officer, accountId, 3_000, randomUUID());
    expect(redo.txn.amount).toBe(3_000);

    // Restoring the trashed withdrawal is refused: its day was taken meanwhile.
    await expect(savings.restoreSavingsTxn(officer, accountId, txnId)).rejects.toMatchObject({
      code: 'WITHDRAWAL_LIMIT',
    });
  });

  it('trashing the latest deposit takes the money back out; restore round-trips', async () => {
    const customerId = await makeCustomer();
    const opened = await savings.openAccount(officer, customerId, undefined, undefined, 'cash');
    const accountId = new Types.ObjectId(opened.account.id);
    const dep = await savings.deposit(officer, accountId, 5_000, randomUUID(), 'cash');
    const txnId = new Types.ObjectId(dep.txn.id);

    const trashed = await savings.trashSavingsTxn(officer, accountId, txnId, undefined);
    expect(trashed.account.balance).toBe(0);

    const restored = await savings.restoreSavingsTxn(officer, accountId, txnId);
    expect(restored.account.balance).toBe(5_000);
    const account = await SavingsAccountModel.findById(accountId);
    expect(account?.balance).toBe(5_000);
  });

  it('closure transactions are immutable', async () => {
    const customerId = await makeCustomer();
    const opened = await savings.openAccount(officer, customerId, 20_000, randomUUID(), 'cash');
    const accountId = new Types.ObjectId(opened.account.id);
    const closure = await savings.closeAccount(officer, accountId);
    expect(closure.payout).toBe(19_000);

    const txns = await savings.listTransactions(officer, accountId, { page: 1, limit: 10 });
    const closureTxn = txns.items.find((t) => t.type === 'closure');
    if (!closureTxn) throw new Error('missing closure txn');
    await expect(
      savings.trashSavingsTxn(officer, accountId, new Types.ObjectId(closureTxn.id), undefined),
    ).rejects.toMatchObject({ code: 'CANNOT_TRASH' });
  });

  it('deletes a middle deposit and rewrites the later running balances', async () => {
    const customerId = await makeCustomer();
    const opened = await savings.openAccount(officer, customerId, undefined, undefined, 'cash');
    const accountId = new Types.ObjectId(opened.account.id);
    const first = await savings.deposit(officer, accountId, 5_000, randomUUID(), 'cash');
    const middle = await savings.deposit(officer, accountId, 3_000, randomUUID(), 'cash');
    await savings.deposit(officer, accountId, 2_000, randomUUID(), 'cash'); // bal 10,000

    // Remove the middle 3,000 — not the newest.
    const trashed = await savings.trashSavingsTxn(
      officer,
      accountId,
      new Types.ObjectId(middle.txn.id),
      'duplicate',
    );
    expect(trashed.account.balance).toBe(7_000);

    // The first keeps 5,000; the last now reads 7,000, not 10,000.
    const firstRow = await SavingsTxnModel.findById(first.txn.id);
    expect(firstRow?.balanceAfter).toBe(5_000);
    const live = await SavingsTxnModel.find({ accountId, deletedAt: null }).sort({ createdAt: 1 });
    expect(live.at(-1)?.balanceAfter).toBe(7_000);
  });

  it('refuses to delete a deposit that a later withdrawal has already spent', async () => {
    const customerId = await makeCustomer();
    const opened = await savings.openAccount(officer, customerId, 6_000, randomUUID(), 'cash');
    const accountId = new Types.ObjectId(opened.account.id);
    const dep = await savings.deposit(officer, accountId, 5_000, randomUUID(), 'cash'); // bal 11,000
    await savings.withdraw(officer, accountId, 9_000, randomUUID()); // bal 1,000

    // Removing the 5,000 deposit would drop the balance below zero at the
    // withdrawal — an impossible history, so it is refused and nothing moves.
    await expect(
      savings.trashSavingsTxn(officer, accountId, new Types.ObjectId(dep.txn.id), undefined),
    ).rejects.toMatchObject({ code: 'CANNOT_TRASH' });
    expect((await SavingsAccountModel.findById(accountId))?.balance).toBe(1_000);
    expect((await SavingsTxnModel.findById(dep.txn.id))?.deletedAt).toBeNull();
  });
});
