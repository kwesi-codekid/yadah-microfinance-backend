import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import {
  AuditLogModel,
  NotificationModel,
  SusuAccountModel,
  SusuDepositCorrectionModel,
  SusuDepositModel,
  UserModel,
} from '../../src/models/index.js';
import * as susu from '../../src/modules/susu/susu.service.js';
import type { AccessTokenPayload } from '../../src/modules/auth/auth.service.js';
import { asOfficer, makeCustomer, makeTeller, setupDb, teardownDb } from './helpers.js';

/**
 * A teller may not correct a deposit; they ask, and the office decides.
 * Approval runs the very same correction the office would make by hand, so
 * every rule that guards a direct correction guards this one — at the moment
 * it is applied, against the account as it stands then.
 */

beforeAll(setupDb);
afterAll(teardownDb);

const officer = asOfficer();
let teller: AccessTokenPayload;
let otherTeller: AccessTokenPayload;

beforeAll(async () => {
  teller = await makeTeller('Asking Teller');
  otherTeller = await makeTeller('Other Teller');
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

/** An account with one deposit of three days on it, ready to be corrected. */
async function accountWithDeposit(): Promise<{
  accountId: Types.ObjectId;
  depositId: Types.ObjectId;
}> {
  const customerId = await makeCustomer();
  const account = await susu.openAccount(officer, customerId, 1_000);
  const accountId = new Types.ObjectId(account.id);
  const rec = await susu.recordDeposit(officer, accountId, 3_000, randomUUID(), 'cash');
  return { accountId, depositId: new Types.ObjectId(rec.deposit.id) };
}

describe('asking for a correction', () => {
  it('records the request and moves nothing', async () => {
    const { accountId, depositId } = await accountWithDeposit();

    const correction = await susu.proposeCorrection(teller, accountId, depositId, {
      amount: 2_000,
      reason: 'Counted three notes, there were two',
    });
    expect(correction.status).toBe('pending');
    expect(correction.amountBefore).toBe(3_000);
    expect(correction.amount).toBe(2_000);
    expect(correction.daysBefore).toBe(3);
    expect(correction.days).toBe(2);
    expect(correction.requestedById).toBe(teller.sub);
    expect(correction.requestedByName).toBe('Asking Teller');

    // The ledger is exactly as it was.
    const deposit = await SusuDepositModel.findById(depositId);
    expect(deposit?.amount).toBe(3_000);
    expect(deposit?.daysCovered).toBe(3);
    const account = await SusuAccountModel.findById(accountId);
    expect(account?.depositsCount).toBe(3);
    expect(account?.totalDeposited).toBe(3_000);

    // The office hears about it; the audit trail has the asking.
    const notified = await NotificationModel.findOne({
      userId: new Types.ObjectId(officer.sub),
      type: 'susu.correction',
      'data.correctionId': correction.id,
    });
    expect(notified?.body).toContain('Asking Teller');
    expect(notified?.body).toContain('Counted three notes');
    expect(
      await AuditLogModel.countDocuments({
        action: 'susu.deposit.correction.propose',
        entityId: new Types.ObjectId(correction.id),
      }),
    ).toBe(1);
  });

  it('is refused on the spot for anything the correction itself would refuse', async () => {
    const { accountId, depositId } = await accountWithDeposit();

    // Not a whole number of days.
    await expect(
      susu.proposeCorrection(teller, accountId, depositId, { amount: 2_500, reason: 'typo' }),
    ).rejects.toMatchObject({ code: 'AMOUNT_MISMATCH', status: 422 });

    // Already that amount — there is nothing to ask for.
    await expect(
      susu.proposeCorrection(teller, accountId, depositId, { amount: 3_000, reason: 'typo' }),
    ).rejects.toMatchObject({ code: 'NO_CHANGE', status: 422 });

    // Past the end of the cycle: 3 days recorded, 28 remain, 32 asked.
    await expect(
      susu.proposeCorrection(teller, accountId, depositId, { amount: 32_000, reason: 'typo' }),
    ).rejects.toMatchObject({ code: 'EXCEEDS_REMAINING', status: 422 });

    // Not the newest deposit once another lands after it.
    await susu.recordDeposit(officer, accountId, 1_000, randomUUID(), 'cash');
    await expect(
      susu.proposeCorrection(teller, accountId, depositId, { amount: 2_000, reason: 'typo' }),
    ).rejects.toMatchObject({ code: 'CANNOT_TRASH', status: 422 });

    expect(await SusuDepositCorrectionModel.countDocuments({ depositId })).toBe(0);
  });

  it('allows one open request per deposit', async () => {
    const { accountId, depositId } = await accountWithDeposit();
    await susu.proposeCorrection(teller, accountId, depositId, { amount: 2_000, reason: 'one' });

    await expect(
      susu.proposeCorrection(otherTeller, accountId, depositId, { amount: 1_000, reason: 'two' }),
    ).rejects.toMatchObject({ code: 'CORRECTION_PENDING', status: 409 });
    expect(await SusuDepositCorrectionModel.countDocuments({ depositId })).toBe(1);
  });
});

describe('deciding a correction', () => {
  it('approval applies the correction and marks the request in one go', async () => {
    const { accountId, depositId } = await accountWithDeposit();
    const asked = await susu.proposeCorrection(teller, accountId, depositId, {
      amount: 2_000,
      reason: 'Counted three notes, there were two',
    });

    const result = await susu.approveCorrection(officer, new Types.ObjectId(asked.id));
    expect(result.correction.status).toBe('approved');
    expect(result.correction.reviewedById).toBe(officer.sub);
    expect(result.correction.reviewedByName).toBe('The Office');
    expect(result.deposit.amount).toBe(2_000);
    expect(result.deposit.daysCovered).toBe(2);
    expect(result.deposit.seqEnd).toBe(2);
    expect(result.account.depositsCount).toBe(2);
    expect(result.account.totalDeposited).toBe(2_000);

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
      userId: new Types.ObjectId(teller.sub),
      type: 'susu.correction',
      'data.correctionId': asked.id,
    });
    expect(told?.title).toBe('Deposit correction approved');

    // Decided is decided.
    await expect(
      susu.approveCorrection(officer, new Types.ObjectId(asked.id)),
    ).rejects.toMatchObject({ code: 'NOT_PENDING', status: 409 });
    await expect(
      susu.rejectCorrection(officer, new Types.ObjectId(asked.id), 'no'),
    ).rejects.toMatchObject({ code: 'NOT_PENDING', status: 409 });
  });

  it('approval is refused, and the request stays open, once the account has moved', async () => {
    const { accountId, depositId } = await accountWithDeposit();
    const asked = await susu.proposeCorrection(teller, accountId, depositId, {
      amount: 2_000,
      reason: 'wrong count',
    });
    // A newer deposit lands before the office looks: the asked-for one is no
    // longer the newest, and the rule that guards a direct correction holds.
    await susu.recordDeposit(officer, accountId, 1_000, randomUUID(), 'cash');

    await expect(
      susu.approveCorrection(officer, new Types.ObjectId(asked.id)),
    ).rejects.toMatchObject({ code: 'CANNOT_TRASH', status: 422 });

    const still = await SusuDepositCorrectionModel.findById(asked.id);
    expect(still?.status).toBe('pending');
    const deposit = await SusuDepositModel.findById(depositId);
    expect(deposit?.amount).toBe(3_000);

    // The office reads why and declines it with that reason.
    const declined = await susu.rejectCorrection(
      officer,
      new Types.ObjectId(asked.id),
      'A newer deposit is on the account — remove it first, then ask again',
    );
    expect(declined.status).toBe('rejected');
    expect(declined.rejectionReason).toContain('newer deposit');
  });

  it('rejection leaves the deposit alone and tells the teller why', async () => {
    const { accountId, depositId } = await accountWithDeposit();
    const asked = await susu.proposeCorrection(teller, accountId, depositId, {
      amount: 2_000,
      reason: 'wrong count',
    });

    const declined = await susu.rejectCorrection(
      officer,
      new Types.ObjectId(asked.id),
      'The customer confirmed three days',
    );
    expect(declined.status).toBe('rejected');
    expect(declined.reviewedById).toBe(officer.sub);

    const deposit = await SusuDepositModel.findById(depositId);
    expect(deposit?.amount).toBe(3_000);
    const told = await NotificationModel.findOne({
      userId: new Types.ObjectId(teller.sub),
      type: 'susu.correction',
      'data.correctionId': asked.id,
    });
    expect(told?.title).toBe('Deposit correction declined');
    expect(told?.body).toContain('The customer confirmed three days');

    // Once declined, the deposit is free to be asked about again.
    const again = await susu.proposeCorrection(teller, accountId, depositId, {
      amount: 1_000,
      reason: 'second look',
    });
    expect(again.status).toBe('pending');
  });

  it('approving a request the office already applied by hand is only the bookkeeping', async () => {
    const { accountId, depositId } = await accountWithDeposit();
    const asked = await susu.proposeCorrection(teller, accountId, depositId, {
      amount: 2_000,
      reason: 'wrong count',
    });
    await susu.updateDeposit(officer, accountId, depositId, 2_000);

    const result = await susu.approveCorrection(officer, new Types.ObjectId(asked.id));
    expect(result.correction.status).toBe('approved');
    expect(result.deposit.amount).toBe(2_000);
    // One correction on the ledger, not two.
    expect(
      await AuditLogModel.countDocuments({ action: 'susu.deposit.update', entityId: depositId }),
    ).toBe(1);
  });
});

describe('taking a request back', () => {
  it('is the author’s to do, or the office’s — not another teller’s', async () => {
    const { accountId, depositId } = await accountWithDeposit();
    const asked = await susu.proposeCorrection(teller, accountId, depositId, {
      amount: 2_000,
      reason: 'wrong count',
    });

    await expect(
      susu.cancelCorrection(otherTeller, new Types.ObjectId(asked.id)),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    const cancelled = await susu.cancelCorrection(teller, new Types.ObjectId(asked.id));
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.reviewedById).toBe(teller.sub);

    await expect(
      susu.approveCorrection(officer, new Types.ObjectId(asked.id)),
    ).rejects.toMatchObject({ code: 'NOT_PENDING' });

    // The office may tidy one away too.
    const second = await susu.proposeCorrection(teller, accountId, depositId, {
      amount: 2_000,
      reason: 'wrong count',
    });
    const tidied = await susu.cancelCorrection(officer, new Types.ObjectId(second.id));
    expect(tidied.status).toBe('cancelled');
  });
});

describe('the queue', () => {
  it('lists newest first, filtered by status or account, with names joined', async () => {
    const a = await accountWithDeposit();
    const b = await accountWithDeposit();
    const first = await susu.proposeCorrection(teller, a.accountId, a.depositId, {
      amount: 2_000,
      reason: 'first',
    });
    const second = await susu.proposeCorrection(otherTeller, b.accountId, b.depositId, {
      amount: 1_000,
      reason: 'second',
    });
    await susu.rejectCorrection(officer, new Types.ObjectId(first.id), 'no');

    const pending = await susu.listCorrections(teller, { status: 'pending', page: 1, limit: 20 });
    expect(pending.items.map((c) => c.id)).toContain(second.id);
    expect(pending.items.map((c) => c.id)).not.toContain(first.id);

    const onA = await susu.listCorrections(otherTeller, {
      accountId: a.accountId,
      page: 1,
      limit: 20,
    });
    expect(onA.total).toBe(1);
    expect(onA.items[0]).toMatchObject({
      id: first.id,
      status: 'rejected',
      requestedByName: 'Asking Teller',
      reviewedByName: 'The Office',
      rejectionReason: 'no',
    });
    expect(onA.items[0]?.customerName).toMatch(/^Test Customer/);
    expect(onA.items[0]?.accountNumber).toMatch(/^SU/);
    expect(onA.items[0]?.accountRef).toMatch(/^\d{12}-[a-f0-9]{4}$/);
  });
});
