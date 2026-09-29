import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { LoanModel, LoanScheduleModel, RepaymentModel } from '../../src/models/index.js';
import * as loans from '../../src/modules/loans/loans.service.js';
import { recordPaperLoan } from '../../src/modules/loans/paper-loans.service.js';
import { runEscalationPass } from '../../src/lib/loan-escalation.js';
import { asOfficer, makeCustomer, setupDb, teardownDb } from './helpers.js';

beforeAll(setupDb);
afterAll(teardownDb);

const officer = asOfficer();

/** Accra day `n` days back from today, as the form sends it. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

describe('recording a paper loan', () => {
  it('writes the loan as history: real dates, paper rate, dated repayments', async () => {
    // A customer with no ID scans at all — a paper loan predates that rule.
    const customerId = await makeCustomer(false, undefined, { withIdDocument: false });
    const loan = await recordPaperLoan(officer, {
      customerId,
      principal: 300_000, // GHS 3,000
      durationMonths: 6,
      ratePercent: 20,
      disbursedOn: daysAgo(100),
      guarantors: [
        { fullName: 'Kofi Mensah', phone: '0241234567' },
        { fullName: 'Efua Owusu', phone: '0551234567', idNumber: 'GHA-1' },
      ],
      repayments: [
        { paidOn: daysAgo(40), amount: 60_000 },
        { paidOn: daysAgo(70), amount: 60_000 },
      ],
      paperRef: 'P-0001',
    });

    expect(loan.origin).toBe('paper');
    expect(loan.paperRef).toBe('P-0001');
    expect(loan.guarantor?.fullName).toBe('Kofi Mensah');
    expect(loan.moreGuarantors).toMatchObject([
      { fullName: 'Efua Owusu', phone: '0551234567', idNumber: 'GHA-1' },
    ]);
    expect(loan.status).toBe('active');
    expect(loan.totalDue).toBe(360_000);
    expect(loan.totalRepaid).toBe(120_000);
    expect(loan.accountNumber).toMatch(/^LN\d{8}$/);
    expect(new Date(loan.disbursedAt ?? 0).toISOString().slice(0, 10)).toBe(daysAgo(100));

    // Each repayment sits on the day it was paid — that is what the cash book reads.
    const repayments = await RepaymentModel.find({ loanId: loan.id }).sort({ createdAt: 1 });
    expect(repayments.map((r) => r.createdAt.toISOString().slice(0, 10))).toEqual([
      daysAgo(70),
      daysAgo(40),
    ]);

    // The schedule starts from the disbursement and has the payments applied.
    const lines = await LoanScheduleModel.find({ loanId: loan.id }).sort({ installmentNumber: 1 });
    expect(lines).toHaveLength(6);
    expect(lines.reduce((s, l) => s + l.amountPaid, 0)).toBe(120_000);
    expect(lines[0]?.status).toBe('paid');
  });

  it('records a loan the customer has finished paying, and it opens the big tier', async () => {
    const customerId = await makeCustomer(true);
    const loan = await recordPaperLoan(officer, {
      customerId,
      principal: 100_000,
      durationMonths: 3,
      ratePercent: 10,
      disbursedOn: daysAgo(400),
      guarantors: [],
      repayments: [{ paidOn: daysAgo(330), amount: 110_000 }],
    });
    expect(loan.status).toBe('repaid');
    expect(loan.repaidOnTime).toBe(true);

    const summary = await loans.eligibilitySummary(customerId);
    expect(summary.bigTierUnlocked).toBe(true);
    // A finished loan is not an open one: the customer may still apply.
    expect(summary.openLoan).toBeNull();
  });

  it('takes paper older than the two-year backdating limit', async () => {
    const customerId = await makeCustomer(true);
    const loan = await recordPaperLoan(officer, {
      customerId,
      principal: 100_000,
      durationMonths: 3,
      ratePercent: 10,
      disbursedOn: daysAgo(1200),
      guarantors: [],
      repayments: [{ paidOn: daysAgo(1150), amount: 110_000 }],
    });
    expect(loan.status).toBe('repaid');
  });

  it('keeps the paper rate the night it is entered, however late the loan is', async () => {
    const customerId = await makeCustomer(true);
    // Eight months old and still on 10% — the ladder alone would escalate it at once.
    const loan = await recordPaperLoan(officer, {
      customerId,
      principal: 100_000,
      durationMonths: 3,
      ratePercent: 10,
      disbursedOn: daysAgo(240),
      guarantors: [],
      repayments: [],
    });
    await runEscalationPass();
    const after = await LoanModel.findById(loan.id);
    expect(after?.ratePercent).toBe(10);
    expect(after?.escalationFrom).toBeDefined();
  });

  it('refuses payments that add up to more than is owed', async () => {
    const customerId = await makeCustomer(true);
    await expect(
      recordPaperLoan(officer, {
        customerId,
        principal: 100_000,
        durationMonths: 3,
        ratePercent: 10,
        disbursedOn: daysAgo(90),
        guarantors: [],
        repayments: [{ paidOn: daysAgo(10), amount: 120_000 }],
      }),
    ).rejects.toMatchObject({ code: 'EXCEEDS_BALANCE' });
  });

  it('refuses a payment dated before the money went out', async () => {
    const customerId = await makeCustomer(true);
    await expect(
      recordPaperLoan(officer, {
        customerId,
        principal: 100_000,
        durationMonths: 3,
        ratePercent: 10,
        disbursedOn: daysAgo(30),
        guarantors: [],
        repayments: [{ paidOn: daysAgo(40), amount: 10_000 }],
      }),
    ).rejects.toMatchObject({ code: 'PAPER_DATES' });
  });

  it('refuses a date that has not happened yet', async () => {
    const customerId = await makeCustomer(true);
    await expect(
      recordPaperLoan(officer, {
        customerId,
        principal: 100_000,
        durationMonths: 3,
        ratePercent: 10,
        disbursedOn: daysAgo(-5),
        guarantors: [],
        repayments: [],
      }),
    ).rejects.toMatchObject({ code: 'DATE_IN_FUTURE' });
  });

  it('refuses the same paper form twice', async () => {
    const customerId = await makeCustomer(true);
    const input = {
      customerId,
      principal: 100_000,
      durationMonths: 3 as const,
      ratePercent: 10 as const,
      disbursedOn: daysAgo(500),
      guarantors: [],
      repayments: [{ paidOn: daysAgo(450), amount: 110_000 }],
      paperRef: 'P-DUP',
    };
    await recordPaperLoan(officer, input);
    await expect(recordPaperLoan(officer, input)).rejects.toMatchObject({
      code: 'PAPER_DUPLICATE',
    });
  });

  it('still allows only one open loan per customer', async () => {
    const customerId = await makeCustomer(true);
    const open = {
      customerId,
      principal: 100_000,
      durationMonths: 3 as const,
      ratePercent: 10 as const,
      disbursedOn: daysAgo(30),
      guarantors: [],
      repayments: [],
    };
    await recordPaperLoan(officer, open);
    await expect(recordPaperLoan(officer, open)).rejects.toMatchObject({ code: 'LOAN_EXISTS' });
  });

  it('is closed to collectors', async () => {
    const customerId = await makeCustomer(true);
    await expect(
      recordPaperLoan(
        { sub: new Types.ObjectId().toHexString(), role: 'collector' },
        {
          customerId,
          principal: 100_000,
          durationMonths: 3,
          ratePercent: 10,
          disbursedOn: daysAgo(30),
          guarantors: [],
          repayments: [],
        },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('importing the paper loan book', () => {
  /** `dd/mm/yyyy`, the way the office writes dates on the sheet. */
  function dmy(daysBack: number): string {
    const [y, m, d] = daysAgo(daysBack).split('-');
    return `${d ?? ''}/${m ?? ''}/${y ?? ''}`;
  }

  async function phoneOf(id: Types.ObjectId): Promise<string> {
    const { CustomerModel } = await import('../../src/models/index.js');
    return (await CustomerModel.findById(id))?.phone ?? '';
  }

  it('groups rows by paper number and records each loan with its payments', async () => {
    const { importPaperLoans } = await import('../../src/modules/loans/paper-loans.import.js');
    const a = await makeCustomer(true);
    const b = await makeCustomer(true);
    const result = await importPaperLoans(officer, [
      {
        row: 2,
        values: {
          paperRef: 'IMP-1',
          customerPhone: await phoneOf(a),
          principal: '1,000',
          durationMonths: '3',
          ratePercent: '10%',
          disbursedOn: dmy(200),
          paidOn: dmy(170),
          amountPaid: '550',
        },
      },
      {
        row: 3,
        values: {
          paperRef: 'IMP-1',
          paidOn: dmy(140),
          amountPaid: '550',
          guarantorName: 'Abena Ofori',
          guarantorPhone: '0271234567',
        },
      },
      {
        row: 4,
        values: {
          paperRef: 'IMP-2',
          customerPhone: await phoneOf(b),
          principal: '2000',
          durationMonths: '6',
          ratePercent: '20',
          disbursedOn: dmy(30),
          guarantorName: 'Yaw Boateng',
          guarantorPhone: '0201234567',
        },
      },
    ]);

    expect(result.counts).toEqual({ total: 2, created: 2, failed: 0 });
    const first = await LoanModel.findOne({ paperRef: 'IMP-1' });
    expect(first?.status).toBe('repaid');
    expect(first?.totalRepaid).toBe(110_000);
    // Named on a later row, like a payment — and the only one, so the first.
    expect(first?.guarantorSnapshot?.fullName).toBe('Abena Ofori');
    expect(first?.moreGuarantors).toBeUndefined();
    const second = await LoanModel.findOne({ paperRef: 'IMP-2' });
    expect(second?.status).toBe('active');
    expect(second?.guarantorSnapshot?.fullName).toBe('Yaw Boateng');
  });

  it('sends back what it could not record, and why, without holding up the rest', async () => {
    const { importPaperLoans } = await import('../../src/modules/loans/paper-loans.import.js');
    const a = await makeCustomer(true);
    const result = await importPaperLoans(officer, [
      {
        row: 2,
        values: {
          paperRef: 'IMP-OK',
          customerPhone: await phoneOf(a),
          principal: '1000',
          durationMonths: '3',
          ratePercent: '10',
          disbursedOn: dmy(500),
          paidOn: dmy(450),
          amountPaid: '1100',
        },
      },
      {
        row: 3,
        values: {
          paperRef: 'IMP-NOBODY',
          customerPhone: '0599999999',
          principal: '1000',
          durationMonths: '4',
          ratePercent: '10',
          disbursedOn: dmy(30),
        },
      },
    ]);

    expect(result.counts).toEqual({ total: 2, created: 1, failed: 1 });
    const failed = result.failed[0];
    expect(failed?.paperRef).toBe('IMP-NOBODY');
    expect(failed?.issues.join(' ')).toMatch(/register them first/);
    expect(failed?.issues.join(' ')).toMatch(/3, 6 or 12/);
  });
});
