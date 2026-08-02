import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { LoanModel, SusuAccountModel } from '../../src/models/index.js';
import * as loans from '../../src/modules/loans/loans.service.js';
import * as susu from '../../src/modules/susu/susu.service.js';
import { asOfficer, makeCustomer, setupDb, teardownDb } from './helpers.js';

beforeAll(setupDb);
afterAll(teardownDb);

const officer = asOfficer();

async function activeLoan(customerId: Types.ObjectId): Promise<Types.ObjectId> {
  const applied = await loans.applyForLoan(officer, customerId, 100_000, 3); // GHS 1,000 → due 1,100
  const loanId = new Types.ObjectId(applied.id);
  await loans.approveLoan(officer, loanId);
  return loanId;
}

describe('loan repayment via susu closure (WBS 7.2)', () => {
  it('closes the account and applies the payout in one transaction', async () => {
    const customerId = await makeCustomer(true);
    const loanId = await activeLoan(customerId);
    const account = await susu.openAccount(officer, customerId, 2_000);
    const accountId = new Types.ObjectId(account.id);
    await susu.recordDeposit(officer, accountId, 25, randomUUID(), 'cash'); // 500 saved → 480 payout

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
    await susu.recordDeposit(officer, accountId, 31, randomUUID(), 'cash'); // payout 60,000 ≫ 10,000

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
    await susu.recordDeposit(officer, accountId, 25, randomUUID(), 'cash'); // payout exactly 48,000

    const result = await loans.repayViaSusuClosure(officer, loanId, accountId, randomUUID());
    expect(result.loan.status).toBe('repaid');
    expect(result.loan.repaidOnTime).toBe(true);
  });
});
