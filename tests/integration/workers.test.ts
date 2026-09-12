import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import {
  AuditLogModel,
  HpAgreementModel,
  HpScheduleModel,
  LoanModel,
} from '../../src/models/index.js';
import { runEscalationPass } from '../../src/lib/loan-escalation.js';
import { runHpArrearsPass } from '../../src/lib/hp-arrears.js';
import * as loans from '../../src/modules/loans/loans.service.js';
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

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/** Active loan whose disbursement is backdated `months` months. */
async function overdueLoan(months: number): Promise<Types.ObjectId> {
  const customerId = await makeCustomer(true);
  const applied = await loans.applyForLoan(officer, customerId, 100_000, 3, guarantor);
  const loanId = new Types.ObjectId(applied.id);
  await loans.approveLoan(officer, loanId);
  const past = new Date(Date.now() - months * MONTH_MS);
  await LoanModel.updateOne(
    { _id: loanId },
    {
      $set: {
        approvedAt: past,
        disbursedAt: past,
        dueDate: new Date(past.getTime() + 3 * MONTH_MS),
      },
    },
    { timestamps: false },
  );
  return loanId;
}

describe('loan escalation worker (assures loans go overdue in due time)', () => {
  it('escalates a loan past its rate window to the next rate on the ORIGINAL principal', async () => {
    const loanId = await overdueLoan(4); // 3-month/10% loan, 4 months old

    await runEscalationPass();

    const after = await LoanModel.findById(loanId);
    expect(after?.ratePercent).toBe(20);
    expect(after?.interestAmount).toBe(20_000); // 20% of the original 100,000
    expect(after?.totalDue).toBe(120_000);
    expect(after?.status).toBe('active');
    expect(after?.escalatedAt).toBeInstanceOf(Date);
    expect(await AuditLogModel.countDocuments({ action: 'loan.escalate', entityId: loanId })).toBe(
      1,
    );
  });

  it('a second pass is a no-op (state-based, safe to run hourly)', async () => {
    const loanId = await overdueLoan(4);
    await runEscalationPass();
    await runEscalationPass();

    const after = await LoanModel.findById(loanId);
    expect(after?.ratePercent).toBe(20); // still one step, not two
    expect(await AuditLogModel.countDocuments({ action: 'loan.escalate', entityId: loanId })).toBe(
      1,
    );
  });

  it('freezes a loan in arrears once escalation is exhausted past 30%', async () => {
    const customerId = await makeCustomer(true);
    const past = new Date(Date.now() - 13 * MONTH_MS);
    const loan = await LoanModel.create({
      customerId,
      tier: 'small',
      principal: 100_000,
      durationMonths: 12,
      ratePercent: 30,
      interestAmount: 30_000,
      totalDue: 130_000,
      totalRepaid: 0,
      status: 'active',
      frozen: false,
      appliedAt: past,
      approvedAt: past,
      disbursedAt: past,
      dueDate: new Date(past.getTime() + 12 * MONTH_MS),
    });

    await runEscalationPass();

    const after = await LoanModel.findById(loan._id);
    expect(after?.status).toBe('arrears');
    expect(after?.frozen).toBe(true);
    expect(after?.ratePercent).toBe(30); // frozen at the top rate
  });
});

describe('hp arrears worker', () => {
  it('flags agreements with an instalment more than a month overdue', async () => {
    const customerId = await makeCustomer();
    const agreement = await HpAgreementModel.create({
      customerId,
      itemId: new Types.ObjectId(),
      itemSnapshot: { name: 'Worker Test Fridge', costPrice: 100_000, sellingPrice: 200_000 },
      depositRequired: 100_000,
      financedAmount: 100_000,
      durationMonths: 6,
      interestRatePercent: 10,
      interestAmount: 10_000,
      totalPayable: 110_000,
      totalPaid: 100_000,
      status: 'active',
      createdById: new Types.ObjectId(),
    });
    await HpScheduleModel.create({
      agreementId: agreement._id,
      customerId,
      installmentNumber: 1,
      dueDate: new Date(Date.now() - 2 * MONTH_MS),
      amountDue: 20_000,
      amountPaid: 0,
      status: 'pending',
    });

    const result = await runHpArrearsPass();
    expect(result.flagged).toBeGreaterThanOrEqual(1);
    const after = await HpAgreementModel.findById(agreement._id);
    expect(after?.status).toBe('in-arrears');
    expect(after?.arrearsAt).toBeInstanceOf(Date);
  });
});
