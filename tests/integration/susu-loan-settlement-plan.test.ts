import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LoanModel, SusuLoanAccountModel } from '../../src/models/index.js';
import * as loans from '../../src/modules/loans/loans.service.js';
import * as savings from '../../src/modules/savings/savings.service.js';
import * as susuLoans from '../../src/modules/susu-loans/susu-loans.service.js';
import { planSusuLoanSettlement } from '../../src/scripts/plan-susu-loan-settlement.js';
import { asOfficer, makeCustomer, makeGuarantor, setupDb, teardownDb } from './helpers.js';

/**
 * The report run before the susu loan account is taken down: what putting
 * every balance against its holder's loan would do, without doing it.
 */

let guarantor: Types.ObjectId;
beforeAll(async () => {
  await setupDb();
  guarantor = await makeGuarantor();
});
afterAll(teardownDb);

const officer = asOfficer();

/** A customer with `balance` in a susu loan account; a GHS 1,100 debt and/or savings as asked. */
async function holder(balance: number, opts: { loan: boolean; savings: boolean }) {
  const customerId = await makeCustomer(true);
  let loanId: Types.ObjectId | undefined;
  if (opts.loan) {
    const applied = await loans.applyForLoan(officer, customerId, 100_000, 3, guarantor);
    loanId = new Types.ObjectId(applied.id);
    await loans.approveLoan(officer, loanId);
  }
  if (opts.savings) await savings.openAccount(officer, customerId, 5_000, randomUUID(), 'cash');
  const { account } = await susuLoans.openAccount(officer, customerId, balance, randomUUID());
  return { customerId: customerId.toHexString(), accountId: account.id, loanId };
}

describe('the susu loan settlement report', () => {
  it('sorts every account holding money into its case, and writes nothing', async () => {
    const partPaid = await holder(30_000, { loan: true, savings: false });
    const paidOff = await holder(110_000, { loan: true, savings: false });
    const leftoverSavings = await holder(125_000, { loan: true, savings: true });
    const leftoverStranded = await holder(125_000, { loan: true, savings: false });
    const noLoanSavings = await holder(8_000, { loan: false, savings: true });
    const noLoanStranded = await holder(8_000, { loan: false, savings: false });
    const empty = await makeCustomer(true);
    await susuLoans.openAccount(officer, empty, undefined, undefined);

    const plan = await planSusuLoanSettlement();
    const row = (h: { customerId: string }) => plan.rows.find((r) => r.customerId === h.customerId);

    expect(row(partPaid)).toMatchObject({
      case: 'part-paid',
      balance: 30_000,
      loanDebt: 110_000,
      toLoan: 30_000,
      leftover: 0,
      loanDebtAfter: 80_000,
    });
    expect(row(paidOff)).toMatchObject({
      case: 'paid-off',
      toLoan: 110_000,
      leftover: 0,
      loanDebtAfter: 0,
    });
    expect(row(leftoverSavings)).toMatchObject({
      case: 'leftover-savings',
      toLoan: 110_000,
      leftover: 15_000,
      loanDebtAfter: 0,
    });
    expect(row(leftoverSavings)?.savingsAccountNumber).toBeTruthy();
    expect(row(leftoverStranded)).toMatchObject({ case: 'leftover-stranded', leftover: 15_000 });
    expect(row(leftoverStranded)?.savingsAccountNumber).toBeUndefined();
    expect(row(noLoanSavings)).toMatchObject({
      case: 'no-loan-savings',
      loanDebt: 0,
      toLoan: 0,
      leftover: 8_000,
    });
    expect(row(noLoanStranded)).toMatchObject({ case: 'no-loan-stranded', leftover: 8_000 });

    // The empty account is counted, not listed.
    expect(plan.rows.some((r) => r.customerId === empty.toHexString())).toBe(false);
    expect(plan.emptyAccounts).toBeGreaterThanOrEqual(1);

    // The totals are the rows added up, and every cedi is either on a loan or left over.
    const sum = (pick: (r: (typeof plan.rows)[number]) => number) =>
      plan.rows.reduce((total, r) => total + pick(r), 0);
    expect(plan.accounts).toBe(plan.rows.length);
    expect(plan.totalBalance).toBe(sum((r) => r.balance));
    expect(plan.totalToLoan + plan.totalLeftover).toBe(plan.totalBalance);
    expect(Object.values(plan.byCase).reduce((n, c) => n + c.accounts, 0)).toBe(plan.accounts);

    // Nothing moved.
    const account = await SusuLoanAccountModel.findById(leftoverSavings.accountId);
    expect(account?.balance).toBe(125_000);
    const loan = await LoanModel.findById(leftoverSavings.loanId);
    expect(loan?.totalRepaid).toBe(0);
  });

  it('notes a loan applied for but not yet given out', async () => {
    const customerId = await makeCustomer(true);
    await loans.applyForLoan(officer, customerId, 100_000, 3, guarantor);
    await susuLoans.openAccount(officer, customerId, 8_000, randomUUID());

    const plan = await planSusuLoanSettlement();
    expect(plan.rows.find((r) => r.customerId === customerId.toHexString())).toMatchObject({
      case: 'no-loan-stranded',
      hasLoanInProgress: true,
    });
  });
});
