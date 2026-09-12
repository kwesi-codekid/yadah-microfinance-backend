import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import {
  HpItemModel,
  SavingsAccountModel,
  SusuAccountModel,
  SusuDepositModel,
} from '../../src/models/index.js';
import * as customers from '../../src/modules/customers/customers.service.js';
import * as hp from '../../src/modules/hire-purchase/hp.service.js';
import * as loans from '../../src/modules/loans/loans.service.js';
import * as savings from '../../src/modules/savings/savings.service.js';
import * as susu from '../../src/modules/susu/susu.service.js';
import { asOfficer, makeCustomer, makeGuarantor, setupDb, teardownDb } from './helpers.js';

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
  const account = await susu.openAccount(officer, customerId, 1_000);
  await susu.recordDeposit(officer, new Types.ObjectId(account.id), 5_000, randomUUID(), 'cash');
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
    const account = await susu.openAccount(officer, customerId, 1_000);
    const accountId = new Types.ObjectId(account.id);

    await expect(customers.trashCustomer(officer, customerId, undefined)).rejects.toMatchObject({
      code: 'CANNOT_TRASH',
    });

    await susu.terminateAccount(officer, accountId);
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
    const customerId = await makeCustomer();
    const used = await susu.openAccount(officer, customerId, 1_000);
    await susu.recordDeposit(officer, new Types.ObjectId(used.id), 1_000, randomUUID(), 'cash');
    await expect(
      susu.trashSusuAccount(officer, new Types.ObjectId(used.id), undefined),
    ).rejects.toMatchObject({ code: 'CANNOT_TRASH' });

    const pristine = await susu.openAccount(officer, customerId, 2_000);
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

    await susu.restoreSusuAccount(officer, pristineId);
    const result = await susu.recordDeposit(officer, pristineId, 2_000, randomUUID(), 'cash');
    expect(result.account.depositsCount).toBe(1);
  });

  it('restore of a live account reports NOT_TRASHED', async () => {
    const customerId = await makeCustomer();
    const account = await susu.openAccount(officer, customerId, 1_000);
    await expect(
      susu.restoreSusuAccount(officer, new Types.ObjectId(account.id)),
    ).rejects.toMatchObject({ code: 'NOT_TRASHED' });
  });
});

describe('savings account trash', () => {
  it('pristine account trashes; an account with any transaction does not', async () => {
    const customerId = await makeCustomer();
    const pristine = await savings.openAccount(officer, customerId, undefined, undefined, 'cash');
    const pristineId = new Types.ObjectId(pristine.account.id);
    await savings.trashSavingsAccount(officer, pristineId, undefined);
    await expect(savings.getAccount(officer, pristineId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const funded = await savings.openAccount(officer, customerId, 5_000, randomUUID(), 'cash');
    await expect(
      savings.trashSavingsAccount(officer, new Types.ObjectId(funded.account.id), undefined),
    ).rejects.toMatchObject({ code: 'CANNOT_TRASH' });
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

  it('active loans can never be trashed', async () => {
    const customerId = await makeCustomer(true);
    const loan = await loans.applyForLoan(officer, customerId, 100_000, 3, guarantor);
    const loanId = new Types.ObjectId(loan.id);
    await loans.approveLoan(officer, loanId);

    await expect(loans.trashLoan(officer, loanId, undefined)).rejects.toMatchObject({
      code: 'CANNOT_TRASH',
    });
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
  it('trashing the latest deposit reverses counters and un-completes the cycle', async () => {
    const customerId = await makeCustomer();
    const account = await susu.openAccount(officer, customerId, 1_000);
    const accountId = new Types.ObjectId(account.id);
    await susu.recordDeposit(officer, accountId, 30_000, randomUUID(), 'cash');
    const last = await susu.recordDeposit(officer, accountId, 1_000, randomUUID(), 'cash');
    expect(last.account.status).toBe('completed');
    const depositId = new Types.ObjectId(last.deposit.id);

    const trashed = await susu.trashDeposit(officer, accountId, depositId, 'entry error');
    expect(trashed.account.status).toBe('active');
    expect(trashed.account.depositsCount).toBe(30);
    expect(trashed.account.totalDeposited).toBe(30_000);

    const restored = await susu.restoreDeposit(officer, accountId, depositId);
    expect(restored.account.status).toBe('completed');
    expect(restored.account.depositsCount).toBe(31);
  });

  it('only the latest deposit can be trashed; replays of trashed keys are refused', async () => {
    const customerId = await makeCustomer();
    const account = await susu.openAccount(officer, customerId, 1_000);
    const accountId = new Types.ObjectId(account.id);
    const key = randomUUID();
    const first = await susu.recordDeposit(officer, accountId, 1_000, key, 'cash');
    await susu.recordDeposit(officer, accountId, 1_000, randomUUID(), 'cash');

    await expect(
      susu.trashDeposit(officer, accountId, new Types.ObjectId(first.deposit.id), undefined),
    ).rejects.toMatchObject({ code: 'CANNOT_TRASH' });

    const second = await SusuDepositModel.findOne({ accountId, seqStart: 2 });
    if (!second) throw new Error('missing second deposit');
    await susu.trashDeposit(officer, accountId, second._id, undefined);
    await expect(
      susu.recordDeposit(officer, accountId, 1_000, second.idempotencyKey ?? '', 'cash'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('PATCH corrects the latest deposit amount and adjusts the account', async () => {
    const customerId = await makeCustomer();
    const account = await susu.openAccount(officer, customerId, 1_000);
    const accountId = new Types.ObjectId(account.id);
    const rec = await susu.recordDeposit(officer, accountId, 3_000, randomUUID(), 'cash');
    const depositId = new Types.ObjectId(rec.deposit.id);

    await expect(susu.updateDeposit(officer, accountId, depositId, 2_500)).rejects.toMatchObject({
      code: 'AMOUNT_MISMATCH',
    });

    const updated = await susu.updateDeposit(officer, accountId, depositId, 1_000);
    expect(updated.deposit.daysCovered).toBe(1);
    expect(updated.deposit.seqEnd).toBe(1);
    const after = await SusuAccountModel.findById(accountId);
    expect(after?.depositsCount).toBe(1);
    expect(after?.totalDeposited).toBe(1_000);
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

    // Restoring the trashed withdrawal must now be refused (newer txns + day taken).
    await expect(savings.restoreSavingsTxn(officer, accountId, txnId)).rejects.toMatchObject({
      code: 'CANNOT_RESTORE',
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
});
