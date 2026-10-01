import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { accountPeriodKey, nextAccountNumber, raiseCounter } from '../../src/lib/account-number.js';
import {
  CounterModel,
  CustomerModel,
  LoanModel,
  SavingsAccountModel,
  SusuAccountModel,
} from '../../src/models/index.js';
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
const period = accountPeriodKey();

describe('account numbers: PREFIX + YYMM + a sequence that runs on for the product', () => {
  // One susu account per customer, for life (client decision, 30 Sep 2026):
  // the number is issued once and never changes.
  it('gives a susu customer one number, issued once', async () => {
    const customerId = await makeCustomer();
    const opened = await susu.openAccount(officer, customerId, 1_000);
    expect(opened.account.accountNumber).toMatch(new RegExp(`^SU${period}[0-9]{4}$`));

    // Closed and reopened, it is the same account under the same number.
    await susu.closeAccount(officer, new Types.ObjectId(opened.account.id));
    const again = await susu.openAccount(officer, customerId, 1_000);
    expect(again.account.accountNumber).toBe(opened.account.accountNumber);
    expect(again.account.id).toBe(opened.account.id);
    expect(await SusuAccountModel.countDocuments({ customerId })).toBe(1);
  });

  it('never gives two customers the same number', async () => {
    const [a, b, c] = await Promise.all([makeCustomer(), makeCustomer(), makeCustomer()]);
    const opened = await Promise.all([
      susu.openAccount(officer, a, 1_000),
      susu.openAccount(officer, b, 1_000),
      susu.openAccount(officer, c, 1_000),
    ]);
    expect(new Set(opened.map((o) => o.account.accountNumber)).size).toBe(3);
  });

  it('stores the number on the customer, and spends one sequence value per customer', async () => {
    const customerId = await makeCustomer();
    const before = (await CounterModel.findById('SU'))?.seq ?? 0;
    const first = await susu.openAccount(officer, customerId, 1_000);
    await susu.closeAccount(officer, new Types.ObjectId(first.account.id));
    await susu.openAccount(officer, customerId, 1_000);
    const after = (await CounterModel.findById('SU'))?.seq ?? 0;

    expect(after - before).toBe(1);
    const customer = await CustomerModel.findById(customerId);
    expect(customer?.susuNumber).toBe(first.account.accountNumber);
  });

  it('keeps the accountNumber index in place, and unique among live accounts', async () => {
    const indexes = await SusuAccountModel.collection.indexes();
    const onNumber = indexes.filter((i) => i.key.accountNumber === 1);
    expect(onNumber.length).toBeGreaterThan(0);
    expect(onNumber.some((i) => i.unique === true)).toBe(true);
  });

  it('gives each product an independent sequence', async () => {
    const customerId = await makeCustomer();
    const { account } = await savings.openAccount(
      officer,
      customerId,
      undefined,
      undefined,
      'cash',
      'standard',
    );

    expect(account.accountNumber).toMatch(new RegExp(`^SV${period}\\d{4}$`));
    // Savings counts from its own counter — one per product, not per month —
    // so opening susu accounts above did not advance it.
    const susuCounter = await CounterModel.findById('SU');
    const savingsCounter = await CounterModel.findById('SV');
    expect(susuCounter?.seq).toBeGreaterThan(0);
    expect(savingsCounter?.seq).toBe(1);
  });

  it('numbers loans at application, so even a rejected one is quotable', async () => {
    const customerId = await makeCustomer(true);
    const loan = await loans.applyForLoan(officer, customerId, 500_000, 3, guarantor);
    expect(loan.accountNumber).toMatch(new RegExp(`^LN${period}\\d{4}$`));

    const stored = await LoanModel.findById(new Types.ObjectId(loan.id));
    expect(stored?.accountNumber).toBe(loan.accountNumber);
  });

  it('runs the sequence on into a new month — the month segment changes, the count does not', async () => {
    // A number that went back to 0001 each month read to customers as
    // starting over (client decision, 1 Oct 2026).
    const august = new Date('2026-08-15T00:00:00.000Z');
    const september = new Date('2026-09-15T00:00:00.000Z');

    const aug1 = await nextAccountNumber('HP', august);
    const aug2 = await nextAccountNumber('HP', august);
    const sep1 = await nextAccountNumber('HP', september);

    expect(aug1).toBe('HP26080001');
    expect(aug2).toBe('HP26080002');
    expect(sep1).toBe('HP26090003');
  });

  it('never reissues a number a backfill already used', async () => {
    await raiseCounter('LN', 40);
    expect(await nextAccountNumber('LN', new Date('2025-01-10T00:00:00.000Z'))).toBe('LN25010041');

    // raiseCounter only moves the counter up, so re-running a migration is safe.
    await raiseCounter('LN', 10);
    expect(await nextAccountNumber('LN', new Date('2025-01-10T00:00:00.000Z'))).toBe('LN25010042');
  });

  it('still accepts grandfathered all-digit numbers', async () => {
    const customerId = await makeCustomer();
    // The shapes that existed before the scheme: 6 digits for susu, 10 for savings.
    const legacySusu = await SusuAccountModel.create({
      accountNumber: '482913',
      customerId,
      openedById: new Types.ObjectId(),
    });
    const legacySavings = await SavingsAccountModel.create({
      accountNumber: '4829130000',
      customerId,
      balance: 0,
      openedById: new Types.ObjectId(),
    });
    expect(legacySusu.accountNumber).toBe('482913');
    expect(legacySavings.accountNumber).toBe('4829130000');
  });

  it('rejects a number carrying the wrong product prefix', async () => {
    const customerId = await makeCustomer();
    await expect(
      SusuAccountModel.create({
        accountNumber: 'SV26080001', // savings prefix on a susu account
        customerId,
        openedById: new Types.ObjectId(),
      }),
    ).rejects.toThrow();
  });
});
