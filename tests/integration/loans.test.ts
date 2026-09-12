import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { CustomerModel, LoanModel, SusuAccountModel } from '../../src/models/index.js';
import * as loans from '../../src/modules/loans/loans.service.js';
import * as susu from '../../src/modules/susu/susu.service.js';
import { asOfficer, makeCustomer, makeGuarantor, setupDb, teardownDb } from './helpers.js';

/** Stands behind every application here. Their own ID is a passport: credit
 *  takes any type, and a fixture holding only Ghana Cards could not show it. */
let guarantor: Types.ObjectId;
beforeAll(async () => {
  await setupDb();
  guarantor = await makeGuarantor();
});
afterAll(teardownDb);

const officer = asOfficer();

async function activeLoan(customerId: Types.ObjectId): Promise<Types.ObjectId> {
  const applied = await loans.applyForLoan(officer, customerId, 100_000, 3, guarantor); // GHS 1,000 → due 1,100
  const loanId = new Types.ObjectId(applied.id);
  await loans.approveLoan(officer, loanId);
  return loanId;
}

describe("the borrower's ID", () => {
  it('refuses an application until both scans are on the profile', async () => {
    const customerId = await makeCustomer(true, undefined, { withIdDocument: false });
    await expect(
      loans.applyForLoan(officer, customerId, 100_000, 3, guarantor),
    ).rejects.toMatchObject({
      code: 'ID_DOCUMENT_REQUIRED',
    });
    const summary = await loans.eligibilitySummary(customerId);
    expect(summary.customer.hasIdDocument).toBe(false);
    expect(summary.customer.hasId).toBe(true);
  });

  it('refuses an application when no ID is recorded at all', async () => {
    const customerId = await makeCustomer(false, undefined, { withIdDocument: false });
    await expect(
      loans.applyForLoan(officer, customerId, 100_000, 3, guarantor),
    ).rejects.toMatchObject({
      code: 'ID_REQUIRED',
    });
  });

  // The branch accepts every ID type it registers customers with. A borrower
  // with a voter ID is as good as one with a Ghana Card.
  it('accepts any ID type, not only the Ghana Card', async () => {
    const customerId = await makeCustomer(false, undefined, { idType: 'voter-id' });
    const applied = await loans.applyForLoan(officer, customerId, 100_000, 3, guarantor);
    expect(applied.status).toBe('pending');

    const summary = await loans.eligibilitySummary(customerId);
    expect(summary.customer.hasId).toBe(true);
    expect(summary.customer.hasGhanaCard).toBe(false);
  });

  it('refuses approval when the scans are gone by decision time', async () => {
    // Unreachable through the API — the profile refuses to drop the scans while
    // the application is open — but an application predating the rule can be.
    const customerId = await makeCustomer(true);
    const applied = await loans.applyForLoan(officer, customerId, 100_000, 3, guarantor);
    await CustomerModel.updateOne(
      { _id: customerId },
      { $unset: { idDocumentFrontUrl: '', idDocumentBackUrl: '' } },
    );
    await expect(loans.approveLoan(officer, new Types.ObjectId(applied.id))).rejects.toMatchObject({
      code: 'ID_DOCUMENT_REQUIRED',
    });
  });
});

/**
 * The guarantor (client request 2026-09-12): somebody has to stand behind the
 * money, and they have to be a customer of the branch with an ID recorded and
 * photographed — the same standard the borrower is held to.
 */
describe('the guarantor', () => {
  it('records who stands behind the loan, with their ID', async () => {
    const customerId = await makeCustomer(true);
    const applied = await loans.applyForLoan(officer, customerId, 100_000, 3, guarantor);

    expect(applied.guarantorId).toBe(guarantor.toHexString());
    expect(applied.guarantor?.idType).toBe('passport');
    expect(applied.guarantor?.idNumber).toBeTruthy();

    const stored = await LoanModel.findById(new Types.ObjectId(applied.id));
    expect(stored?.guarantorId?.toHexString()).toBe(guarantor.toHexString());
    // A snapshot, so a later change to their profile cannot rewrite the record.
    const named = await CustomerModel.findById(guarantor);
    expect(stored?.guarantorSnapshot?.fullName).toBe(named?.fullName);
    expect(stored?.guarantorSnapshot?.phone).toBe(named?.phone);
  });

  it('refuses a customer standing behind their own borrowing', async () => {
    const customerId = await makeCustomer(true);
    await expect(
      loans.applyForLoan(officer, customerId, 100_000, 3, customerId),
    ).rejects.toMatchObject({ code: 'GUARANTOR_IS_BORROWER' });
  });

  it('refuses a guarantor who is not on the books', async () => {
    const customerId = await makeCustomer(true);
    await expect(
      loans.applyForLoan(officer, customerId, 100_000, 3, new Types.ObjectId()),
    ).rejects.toMatchObject({ code: 'GUARANTOR_NOT_FOUND' });
  });

  it('refuses a deactivated guarantor', async () => {
    const customerId = await makeCustomer(true);
    const dormant = await makeGuarantor();
    await CustomerModel.updateOne({ _id: dormant }, { $set: { status: 'inactive' } });
    await expect(
      loans.applyForLoan(officer, customerId, 100_000, 3, dormant),
    ).rejects.toMatchObject({ code: 'GUARANTOR_INACTIVE' });
  });

  it("names which half of the guarantor's ID is missing", async () => {
    const customerId = await makeCustomer(true);
    // An ID recorded, but never photographed.
    const unphotographed = await makeCustomer(false, undefined, {
      idType: 'drivers-license',
      withIdDocument: false,
    });
    await expect(
      loans.applyForLoan(officer, customerId, 100_000, 3, unphotographed),
    ).rejects.toMatchObject({
      code: 'GUARANTOR_ID_INCOMPLETE',
      details: { missing: ['a photo of both sides of the ID'] },
    });

    // Photographed, but no type or number on the profile.
    const unrecorded = await makeCustomer(false);
    await expect(
      loans.applyForLoan(officer, customerId, 100_000, 3, unrecorded),
    ).rejects.toMatchObject({
      code: 'GUARANTOR_ID_INCOMPLETE',
      details: { missing: ['the ID type and number'] },
    });
  });

  it('lets one person stand behind more than one loan', async () => {
    const [a, b] = await Promise.all([makeCustomer(true), makeCustomer(true)]);
    const shared = await makeGuarantor();
    await loans.applyForLoan(officer, a, 100_000, 3, shared);
    const second = await loans.applyForLoan(officer, b, 100_000, 3, shared);
    expect(second.guarantorId).toBe(shared.toHexString());
  });
});

describe('loan repayment via susu closure (WBS 7.2)', () => {
  it('closes the account and applies the payout in one transaction', async () => {
    const customerId = await makeCustomer(true);
    const loanId = await activeLoan(customerId);
    const account = await susu.openAccount(officer, customerId, 2_000);
    const accountId = new Types.ObjectId(account.id);
    await susu.recordDeposit(officer, accountId, 50_000, randomUUID(), 'cash'); // 500 saved → 480 payout

    const result = await loans.repayViaSusuClosure(officer, loanId, accountId, randomUUID());
    expect(result.susuClosure?.payout).toBe(48_000);
    expect(result.loan.totalRepaid).toBe(48_000);

    const closed = await SusuAccountModel.findById(accountId);
    expect(closed?.status).toBe('closed');
    expect(closed?.commissionAmount).toBe(2_000);
  });

  it('excess payout settles the loan and leaves the rest pending withdrawal', async () => {
    const customerId = await makeCustomer(true);
    const loanId = await activeLoan(customerId);
    // Pay down to a small remainder so a full cycle overshoots.
    await loans.repayCash(officer, loanId, 100_000, randomUUID(), 'cash'); // remaining 10,000

    const account = await susu.openAccount(officer, customerId, 2_000);
    const accountId = new Types.ObjectId(account.id);
    await susu.recordDeposit(officer, accountId, 62_000, randomUUID(), 'cash'); // payout 60,000 ≫ 10,000

    const result = await loans.repayViaSusuClosure(officer, loanId, accountId, randomUUID());
    expect(result.susuClosure?.applied).toBe(10_000);
    expect(result.susuClosure?.excess).toBe(50_000);
    expect(result.loan.status).toBe('repaid');

    // Client-confirmed: excess stays in the susu account pending withdrawal.
    const account2 = await SusuAccountModel.findById(accountId);
    expect(account2?.status).toBe('pending-payout');
    expect(account2?.payoutRemaining).toBe(50_000);
    const loan = await LoanModel.findById(loanId);
    expect(loan?.totalRepaid).toBe(110_000);
  });

  it('settling exactly via susu closure flips the loan to repaid', async () => {
    const customerId = await makeCustomer(true);
    const loanId = await activeLoan(customerId); // due 110,000
    await loans.repayCash(officer, loanId, 62_000, randomUUID(), 'cash'); // remaining 48,000

    const account = await susu.openAccount(officer, customerId, 2_000);
    const accountId = new Types.ObjectId(account.id);
    await susu.recordDeposit(officer, accountId, 50_000, randomUUID(), 'cash'); // payout exactly 48,000

    const result = await loans.repayViaSusuClosure(officer, loanId, accountId, randomUUID());
    expect(result.loan.status).toBe('repaid');
    expect(result.loan.repaidOnTime).toBe(true);
  });
});
