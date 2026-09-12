import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import {
  AuditLogModel,
  HpAgreementModel,
  HpPaymentModel,
  HpScheduleModel,
  LoanModel,
  LoanScheduleModel,
  NotificationModel,
  RepaymentModel,
  SavingsAccountModel,
  SavingsTxnModel,
  SusuAccountModel,
  SusuDepositModel,
  TxnCorrectionModel,
  UserModel,
} from '../../src/models/index.js';
import { MIN_BALANCE, WITHDRAWAL_FEE } from '../../src/domain/savings.js';
import * as corrections from '../../src/modules/corrections/corrections.service.js';
import * as hp from '../../src/modules/hire-purchase/hp.service.js';
import * as loans from '../../src/modules/loans/loans.service.js';
import * as savings from '../../src/modules/savings/savings.service.js';
import * as susu from '../../src/modules/susu/susu.service.js';
import type { AccessTokenPayload } from '../../src/modules/auth/auth.service.js';
import {
  asOfficer,
  makeCustomer,
  makeGuarantor,
  makeTeller,
  setupDb,
  teardownDb,
} from './helpers.js';

/**
 * Correcting a figure already on the ledger.
 *
 * The office corrects outright; a teller asks, and the office decides.
 * Approval runs the very same correction the office would make by hand, so
 * every rule that guards a direct correction guards this one — at the moment
 * it is applied, against the record as it stands then. The asking and the
 * deciding are the same whatever the figure is on; what the correction does
 * to the record behind it is each module's own, and each is exercised below.
 */

beforeAll(setupDb);
afterAll(teardownDb);

const officer = asOfficer();
let teller: AccessTokenPayload;
let otherTeller: AccessTokenPayload;
let guarantor: Types.ObjectId;

beforeAll(async () => {
  teller = await makeTeller('Asking Teller');
  otherTeller = await makeTeller('Other Teller');
  guarantor = await makeGuarantor();
  // The officer is a bare token everywhere else; here they must exist so the
  // office notification has somebody to reach.
  await UserModel.create({
    _id: new Types.ObjectId(officer.sub),
    name: 'The Office',
    username: `admin-${officer.sub}`,
    phone: '0209000001',
    role: 'admin',
    status: 'active',
    passwordHash: 'x'.repeat(60),
  });
});

const oid = (id: string): Types.ObjectId => new Types.ObjectId(id);

/** A susu account with one deposit of three days on it, ready to be corrected. */
async function susuFixture(): Promise<{ accountId: Types.ObjectId; depositId: Types.ObjectId }> {
  const customerId = await makeCustomer();
  const account = await susu.openAccount(officer, customerId, 1_000);
  const accountId = oid(account.id);
  const rec = await susu.recordDeposit(officer, accountId, 3_000, randomUUID(), 'cash');
  return { accountId, depositId: oid(rec.deposit.id) };
}

/* ------------------------------------------------------------- the asking --- */

describe('asking for a correction', () => {
  it('records the request and moves nothing', async () => {
    const { accountId, depositId } = await susuFixture();

    const correction = await corrections.propose(teller, 'susu-deposit', accountId, depositId, {
      amount: 2_000,
      reason: 'Counted three notes, there were two',
    });
    expect(correction).toMatchObject({
      kind: 'susu-deposit',
      status: 'pending',
      amountBefore: 3_000,
      amount: 2_000,
      unitsBefore: 3,
      units: 2,
      requestedById: teller.sub,
      requestedByName: 'Asking Teller',
    });
    expect(correction.targetNumber).toMatch(/^SU/);
    expect(correction.targetLabel).toMatch(/^\d{12}-[a-f0-9]{4}$/);

    // The ledger is exactly as it was.
    const deposit = await SusuDepositModel.findById(depositId);
    expect(deposit?.amount).toBe(3_000);
    const account = await SusuAccountModel.findById(accountId);
    expect(account?.depositsCount).toBe(3);
    expect(account?.totalDeposited).toBe(3_000);

    // The office hears about it; the audit trail has the asking.
    const notified = await NotificationModel.findOne({
      userId: oid(officer.sub),
      type: 'txn.correction',
      'data.correctionId': correction.id,
    });
    expect(notified?.body).toContain('Asking Teller');
    expect(notified?.body).toContain('Counted three notes');
    expect(
      await AuditLogModel.countDocuments({
        action: 'txn.correction.propose',
        entityId: oid(correction.id),
      }),
    ).toBe(1);
  });

  it('is refused on the spot for anything the correction itself would refuse', async () => {
    const { accountId, depositId } = await susuFixture();
    const ask = (amount: number): Promise<unknown> =>
      corrections.propose(teller, 'susu-deposit', accountId, depositId, { amount, reason: 'typo' });

    // Not a whole number of days; already that amount; past the cycle's end.
    await expect(ask(2_500)).rejects.toMatchObject({ code: 'AMOUNT_MISMATCH', status: 422 });
    await expect(ask(3_000)).rejects.toMatchObject({ code: 'NO_CHANGE', status: 422 });
    await expect(ask(32_000)).rejects.toMatchObject({ code: 'EXCEEDS_REMAINING', status: 422 });

    // Not the newest deposit once another lands after it.
    await susu.recordDeposit(officer, accountId, 1_000, randomUUID(), 'cash');
    await expect(ask(2_000)).rejects.toMatchObject({ code: 'CANNOT_TRASH', status: 422 });

    expect(await TxnCorrectionModel.countDocuments({ txnId: depositId })).toBe(0);
  });

  it('allows one open request per transaction', async () => {
    const { accountId, depositId } = await susuFixture();
    await corrections.propose(teller, 'susu-deposit', accountId, depositId, {
      amount: 2_000,
      reason: 'one',
    });
    await expect(
      corrections.propose(otherTeller, 'susu-deposit', accountId, depositId, {
        amount: 1_000,
        reason: 'two',
      }),
    ).rejects.toMatchObject({ code: 'CORRECTION_PENDING', status: 409 });
    expect(await TxnCorrectionModel.countDocuments({ txnId: depositId })).toBe(1);
  });
});

/* ----------------------------------------------------------- the deciding --- */

describe('deciding a correction', () => {
  it('approval applies the correction and marks the request in one go', async () => {
    const { accountId, depositId } = await susuFixture();
    const asked = await corrections.propose(teller, 'susu-deposit', accountId, depositId, {
      amount: 2_000,
      reason: 'Counted three notes, there were two',
    });

    const result = await corrections.approve(officer, oid(asked.id));
    expect(result.correction.status).toBe('approved');
    expect(result.correction.reviewedById).toBe(officer.sub);
    expect(result.correction.reviewedByName).toBe('The Office');
    expect(result.txn).toMatchObject({ amount: 2_000, daysCovered: 2, seqEnd: 2 });
    expect(result.target).toMatchObject({ depositsCount: 2, totalDeposited: 2_000 });

    // The ledger's own audit entry names the approver as actor and the teller
    // as the one who asked, so both questions can be answered.
    const applied = await AuditLogModel.findOne({
      action: 'susu.deposit.update',
      entityId: depositId,
    });
    expect(applied?.actorId.toHexString()).toBe(officer.sub);
    expect(applied?.after).toMatchObject({
      amount: 2_000,
      correctionId: asked.id,
      requestedById: teller.sub,
    });

    // The teller hears the answer.
    const told = await NotificationModel.findOne({
      userId: oid(teller.sub),
      type: 'txn.correction',
      'data.correctionId': asked.id,
    });
    expect(told?.title).toBe('Correction approved');

    // Decided is decided.
    await expect(corrections.approve(officer, oid(asked.id))).rejects.toMatchObject({
      code: 'NOT_PENDING',
      status: 409,
    });
    await expect(corrections.reject(officer, oid(asked.id), 'no')).rejects.toMatchObject({
      code: 'NOT_PENDING',
      status: 409,
    });
  });

  it('approval is refused, and the request stays open, once the record has moved', async () => {
    const { accountId, depositId } = await susuFixture();
    const asked = await corrections.propose(teller, 'susu-deposit', accountId, depositId, {
      amount: 2_000,
      reason: 'wrong count',
    });
    // A newer deposit lands before the office looks: the asked-for one is no
    // longer the newest, and the rule that guards a direct correction holds.
    await susu.recordDeposit(officer, accountId, 1_000, randomUUID(), 'cash');

    await expect(corrections.approve(officer, oid(asked.id))).rejects.toMatchObject({
      code: 'CANNOT_TRASH',
      status: 422,
    });
    expect((await TxnCorrectionModel.findById(asked.id))?.status).toBe('pending');
    expect((await SusuDepositModel.findById(depositId))?.amount).toBe(3_000);

    // The office reads why and declines it with that reason.
    const declined = await corrections.reject(
      officer,
      oid(asked.id),
      'A newer deposit is on the account — remove it first, then ask again',
    );
    expect(declined.status).toBe('rejected');
    expect(declined.rejectionReason).toContain('newer deposit');
  });

  it('rejection leaves the transaction alone and tells the teller why', async () => {
    const { accountId, depositId } = await susuFixture();
    const asked = await corrections.propose(teller, 'susu-deposit', accountId, depositId, {
      amount: 2_000,
      reason: 'wrong count',
    });

    const declined = await corrections.reject(
      officer,
      oid(asked.id),
      'The customer confirmed three days',
    );
    expect(declined.status).toBe('rejected');
    expect(declined.reviewedById).toBe(officer.sub);
    expect((await SusuDepositModel.findById(depositId))?.amount).toBe(3_000);

    const told = await NotificationModel.findOne({
      userId: oid(teller.sub),
      type: 'txn.correction',
      'data.correctionId': asked.id,
    });
    expect(told?.title).toBe('Correction declined');
    expect(told?.body).toContain('The customer confirmed three days');

    // Once declined, the transaction is free to be asked about again.
    const again = await corrections.propose(teller, 'susu-deposit', accountId, depositId, {
      amount: 1_000,
      reason: 'second look',
    });
    expect(again.status).toBe('pending');
  });

  it('approving a request the office already applied by hand is only the bookkeeping', async () => {
    const { accountId, depositId } = await susuFixture();
    const asked = await corrections.propose(teller, 'susu-deposit', accountId, depositId, {
      amount: 2_000,
      reason: 'wrong count',
    });
    await susu.updateDeposit(officer, accountId, depositId, 2_000);

    const result = await corrections.approve(officer, oid(asked.id));
    expect(result.correction.status).toBe('approved');
    expect(result.txn).toMatchObject({ amount: 2_000 });
    // One correction on the ledger, not two.
    expect(
      await AuditLogModel.countDocuments({ action: 'susu.deposit.update', entityId: depositId }),
    ).toBe(1);
  });

  it('taking back is the author’s to do, or the office’s — not another teller’s', async () => {
    const { accountId, depositId } = await susuFixture();
    const asked = await corrections.propose(teller, 'susu-deposit', accountId, depositId, {
      amount: 2_000,
      reason: 'wrong count',
    });

    await expect(corrections.cancel(otherTeller, oid(asked.id))).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    const cancelled = await corrections.cancel(teller, oid(asked.id));
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.reviewedById).toBe(teller.sub);
    await expect(corrections.approve(officer, oid(asked.id))).rejects.toMatchObject({
      code: 'NOT_PENDING',
    });

    // The office may tidy one away too.
    const second = await corrections.propose(teller, 'susu-deposit', accountId, depositId, {
      amount: 2_000,
      reason: 'wrong count',
    });
    expect((await corrections.cancel(officer, oid(second.id))).status).toBe('cancelled');
  });
});

/* ------------------------------------------------------------- the queue --- */

describe('the queue', () => {
  it('lists newest first, filtered by status, kind or record, with names joined', async () => {
    const a = await susuFixture();
    const b = await susuFixture();
    const first = await corrections.propose(teller, 'susu-deposit', a.accountId, a.depositId, {
      amount: 2_000,
      reason: 'first',
    });
    const second = await corrections.propose(
      otherTeller,
      'susu-deposit',
      b.accountId,
      b.depositId,
      { amount: 1_000, reason: 'second' },
    );
    await corrections.reject(officer, oid(first.id), 'no');

    const pending = await corrections.list(teller, { status: 'pending', page: 1, limit: 20 });
    expect(pending.items.map((c) => c.id)).toContain(second.id);
    expect(pending.items.map((c) => c.id)).not.toContain(first.id);

    const onA = await corrections.list(otherTeller, {
      targetId: a.accountId,
      page: 1,
      limit: 20,
    });
    expect(onA.total).toBe(1);
    expect(onA.items[0]).toMatchObject({
      id: first.id,
      kind: 'susu-deposit',
      status: 'rejected',
      requestedByName: 'Asking Teller',
      reviewedByName: 'The Office',
      rejectionReason: 'no',
    });
    expect(onA.items[0]?.customerName).toMatch(/^Test Customer/);

    const susuOnly = await corrections.list(teller, { kind: 'susu-deposit', page: 1, limit: 100 });
    expect(susuOnly.items.every((c) => c.kind === 'susu-deposit')).toBe(true);
  });
});

/* --------------------------------------------------------------- savings --- */

describe('savings transactions', () => {
  it('corrects the newest deposit: the balance and the running balance move with it', async () => {
    const customerId = await makeCustomer();
    const opened = await savings.openAccount(officer, customerId, 20_000, randomUUID(), 'cash');
    const accountId = oid(opened.account.id);
    const dep = await savings.deposit(officer, accountId, 3_000, randomUUID(), 'cash');
    const txnId = oid(dep.txn.id);

    // The office, outright.
    const result = await corrections.correct(officer, 'savings-txn', accountId, txnId, 5_000);
    expect(result.txn).toMatchObject({ amount: 5_000, balanceAfter: 25_000 });
    expect(result.target).toMatchObject({ balance: 25_000 });
    expect((await SavingsAccountModel.findById(accountId))?.balance).toBe(25_000);

    // Below the floor every deposit has.
    await expect(
      corrections.correct(officer, 'savings-txn', accountId, txnId, 400),
    ).rejects.toMatchObject({ code: 'AMOUNT_TOO_SMALL', status: 422 });

    // The opening deposit is no longer the newest, so it is final from here.
    const opening = await SavingsTxnModel.findOne({ accountId, amount: 20_000 });
    if (!opening) throw new Error('missing opening deposit');
    await expect(
      corrections.correct(officer, 'savings-txn', accountId, opening._id, 21_000),
    ).rejects.toMatchObject({ code: 'CANNOT_CORRECT', status: 422 });
  });

  it('corrects a withdrawal against what the account held before it, fee kept', async () => {
    const customerId = await makeCustomer();
    const opened = await savings.openAccount(officer, customerId, 20_000, randomUUID(), 'cash');
    const accountId = oid(opened.account.id);
    const wd = await savings.withdraw(officer, accountId, 2_000, randomUUID());
    const txnId = oid(wd.txn.id);
    // 20,000 − 2,000 − the fee.
    expect(wd.txn.balanceAfter).toBe(20_000 - 2_000 - WITHDRAWAL_FEE);

    // What could have been withdrawn that day is the same figure as then:
    // the balance before it, less the floor and the fee.
    const available = 20_000 - MIN_BALANCE - WITHDRAWAL_FEE;
    await expect(
      corrections.correct(officer, 'savings-txn', accountId, txnId, available + 1),
    ).rejects.toMatchObject({ code: 'EXCEEDS_AVAILABLE', status: 422 });

    const asked = await corrections.propose(teller, 'savings-txn', accountId, txnId, {
      amount: available,
      reason: 'Handed over the whole of it',
    });
    const result = await corrections.approve(officer, oid(asked.id));
    expect(result.txn).toMatchObject({
      amount: available,
      fee: WITHDRAWAL_FEE,
      balanceAfter: 20_000 - available - WITHDRAWAL_FEE,
    });
    expect((await SavingsAccountModel.findById(accountId))?.balance).toBe(
      20_000 - available - WITHDRAWAL_FEE,
    );
    expect(
      await AuditLogModel.countDocuments({ action: 'savings.txn.update', entityId: txnId }),
    ).toBe(1);
  });
});

/* ----------------------------------------------------------------- loans --- */

async function activeLoan(): Promise<Types.ObjectId> {
  const customerId = await makeCustomer(true);
  // GHS 1,000 over 3 months → GHS 1,100 due.
  const applied = await loans.applyForLoan(officer, customerId, 100_000, 3, guarantor);
  const loanId = oid(applied.id);
  await loans.approveLoan(officer, loanId);
  return loanId;
}

describe('loan repayments', () => {
  it('corrects the newest cash repayment and rebuilds the schedule from the new total', async () => {
    const loanId = await activeLoan();
    const paid = await loans.repayCash(officer, loanId, 30_000, randomUUID(), 'cash');
    const repaymentId = oid(paid.repayment.id);

    const asked = await corrections.propose(teller, 'loan-repayment', loanId, repaymentId, {
      amount: 50_000,
      reason: 'The customer paid five hundred, not three',
    });
    const result = await corrections.approve(officer, oid(asked.id));
    expect(result.txn).toMatchObject({ amount: 50_000, source: 'cash' });
    expect(result.target).toMatchObject({ totalRepaid: 50_000, remaining: 60_000 });

    // Filled oldest instalment first from the new total, as the original
    // allocation was: the first month is covered and the second is partly.
    const schedule = await LoanScheduleModel.find({ loanId }).sort({ installmentNumber: 1 });
    const totalAllocated = schedule.reduce((sum, s) => sum + s.amountPaid, 0);
    expect(totalAllocated).toBe(50_000);
    expect(schedule[0]?.status).toBe('paid');
    expect(schedule[2]?.status).toBe('pending');

    // More than the loan owed before this repayment landed.
    await expect(
      corrections.correct(officer, 'loan-repayment', loanId, repaymentId, 110_001),
    ).rejects.toMatchObject({ code: 'EXCEEDS_BALANCE', status: 422 });
  });

  it('a corrected repayment can settle the loan, and a corrected settlement reopens it', async () => {
    const loanId = await activeLoan();
    const paid = await loans.repayCash(officer, loanId, 100_000, randomUUID(), 'cash');
    const repaymentId = oid(paid.repayment.id);

    // Up to exactly what was owed: settled.
    await corrections.correct(officer, 'loan-repayment', loanId, repaymentId, 110_000);
    const settled = await LoanModel.findById(loanId);
    expect(settled?.status).toBe('repaid');
    expect(settled?.closedAt).toBeDefined();
    expect(settled?.repaidOnTime).toBe(true);

    // Back down: the loan is open again, with nothing left saying it closed.
    await corrections.correct(officer, 'loan-repayment', loanId, repaymentId, 90_000);
    const reopened = await LoanModel.findById(loanId);
    expect(reopened?.status).toBe('active');
    expect(reopened?.totalRepaid).toBe(90_000);
    expect(reopened?.closedAt).toBeUndefined();
    expect(reopened?.repaidOnTime).toBeUndefined();
    expect((await RepaymentModel.findById(repaymentId))?.amount).toBe(90_000);
  });

  it('refuses a repayment that did not come as cash', async () => {
    const loanId = await activeLoan();
    const loan = await LoanModel.findById(loanId);
    if (!loan) throw new Error('missing loan');
    // A repayment written by a transfer, as the transfers module would write it.
    const moved = await RepaymentModel.create({
      loanId,
      customerId: loan.customerId,
      amount: 10_000,
      source: 'transfer',
      channel: 'transfer',
      recordedById: oid(officer.sub),
    });
    await LoanModel.updateOne({ _id: loanId }, { $inc: { totalRepaid: 10_000 } });

    await expect(
      corrections.correct(officer, 'loan-repayment', loanId, moved._id, 5_000),
    ).rejects.toMatchObject({ code: 'CANNOT_CORRECT', status: 422 });
  });
});

/* -------------------------------------------------------- hire purchase --- */

/** A customer with the four months of susu history hire purchase asks for. */
async function eligibleCustomer(): Promise<Types.ObjectId> {
  const customerId = await makeCustomer();
  const account = await susu.openAccount(officer, customerId, 1_000);
  await susu.recordDeposit(officer, oid(account.id), 5_000, randomUUID(), 'cash');
  await SusuDepositModel.updateMany(
    { customerId },
    { $set: { createdAt: new Date(Date.now() - 130 * 24 * 60 * 60 * 1000) } },
    { timestamps: false, overwriteImmutable: true },
  );
  return customerId;
}

/** An active agreement: signed by the office, deposit paid, item released. */
async function activeAgreement(): Promise<{
  agreementId: Types.ObjectId;
  depositId: Types.ObjectId;
  totalPayable: number;
}> {
  const customerId = await eligibleCustomer();
  const item = await hp.createItem(officer, {
    name: `Correction Test Item ${randomUUID().slice(0, 8)}`,
    quantityInStock: 1,
    costPrice: 100_000,
    sellingPrice: 200_000,
  });
  const signed = await hp.createAgreement(officer, {
    customerId,
    itemId: oid(item.id),
    agreedPrice: 200_000,
    durationMonths: 3,
  });
  const agreementId = oid(signed.id);
  await hp.recordDeposit(officer, agreementId, signed.depositRequired, randomUUID(), 'cash');
  const after = await HpAgreementModel.findById(agreementId);
  const deposit = await HpPaymentModel.findOne({ agreementId, type: 'deposit' });
  if (!after?.totalPayable || !deposit) throw new Error('agreement did not activate');
  return { agreementId, depositId: deposit._id, totalPayable: after.totalPayable };
}

describe('hire-purchase payments', () => {
  it('corrects the newest instalment and rebuilds the plan from the new total', async () => {
    const { agreementId, depositId, totalPayable } = await activeAgreement();
    const paid = await hp.payInstallment(officer, agreementId, 20_000, randomUUID(), 'cash');
    expect(paid.agreement.remaining).toBe(totalPayable - 20_000);
    const payment = await HpPaymentModel.findOne({ agreementId, type: 'installment' });
    if (!payment) throw new Error('missing instalment');

    const asked = await corrections.propose(teller, 'hp-payment', agreementId, payment._id, {
      amount: 30_000,
      reason: 'Three hundred, not two',
    });
    const result = await corrections.approve(officer, oid(asked.id));
    expect(result.txn).toMatchObject({ amount: 30_000, type: 'installment' });
    expect(result.target).toMatchObject({
      totalPaid: 100_000 + 30_000,
      remaining: totalPayable - 30_000,
    });
    const schedule = await HpScheduleModel.find({ agreementId }).sort({ installmentNumber: 1 });
    expect(schedule.reduce((sum, s) => sum + s.amountPaid, 0)).toBe(30_000);

    // The deposit is fixed by the agreement; more than is owed is refused.
    await expect(
      corrections.correct(officer, 'hp-payment', agreementId, depositId, 90_000),
    ).rejects.toMatchObject({ code: 'CANNOT_CORRECT', status: 422 });
    await expect(
      corrections.correct(officer, 'hp-payment', agreementId, payment._id, totalPayable + 1),
    ).rejects.toMatchObject({ code: 'EXCEEDS_BALANCE', status: 422 });
  });

  it('a corrected instalment can complete the agreement, and a corrected completion reopens it', async () => {
    const { agreementId, totalPayable } = await activeAgreement();
    await hp.payInstallment(officer, agreementId, 20_000, randomUUID(), 'cash');
    const payment = await HpPaymentModel.findOne({ agreementId, type: 'installment' });
    if (!payment) throw new Error('missing instalment');

    await corrections.correct(officer, 'hp-payment', agreementId, payment._id, totalPayable);
    const completed = await HpAgreementModel.findById(agreementId);
    expect(completed?.status).toBe('closed-completed');
    expect(completed?.closedAt).toBeDefined();

    await corrections.correct(officer, 'hp-payment', agreementId, payment._id, 50_000);
    const reopened = await HpAgreementModel.findById(agreementId);
    expect(reopened?.status).toBe('active');
    expect(reopened?.closedAt).toBeUndefined();
    expect(reopened?.totalPaid).toBe(100_000 + 50_000);
  });
});
