import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import {
  accountPeriodKey,
  bareAccountNumber,
  cycleMonthOf,
  nextAccountNumber,
  raiseCounter,
} from '../../src/lib/account-number.js';
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

describe('account numbers: PREFIX + YYMM + 4-digit monthly sequence', () => {
  // One number per customer, their books separated by month inside it (client
  // decision, 12 Sep 2026). What used to be asserted here — that a second
  // account is one higher — is now precisely the bug.
  it('gives one customer the same number for every book in a month', async () => {
    const customerId = await makeCustomer();
    const first = await susu.openAccount(officer, customerId, 1_000);
    const second = await susu.openAccount(officer, customerId, 2_000);

    const shape = new RegExp(
      `^SU${period}[0-9]{4}-(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)$`,
    );
    expect(first.accountNumber).toMatch(shape);
    expect(first.cycleMonth).toBe(cycleMonthOf());
    // Byte for byte, which is the whole of what the branch asked for.
    expect(second.accountNumber).toBe(first.accountNumber);
    // Two books all the same: different accounts, different refs, one number.
    expect(second.id).not.toBe(first.id);
    expect(second.ref).not.toBe(first.ref);
    expect(await SusuAccountModel.countDocuments({ customerId })).toBe(2);
  });

  it('keeps the number and changes the month for a later book', async () => {
    const customerId = await makeCustomer();
    const sep = await susu.openAccount(officer, customerId, 1_000, 'SEP');
    const oct = await susu.openAccount(officer, customerId, 1_000, 'OCT');

    expect(sep.accountNumber.endsWith('-SEP')).toBe(true);
    expect(oct.accountNumber.endsWith('-OCT')).toBe(true);
    expect(bareAccountNumber(oct.accountNumber)).toBe(bareAccountNumber(sep.accountNumber));
  });

  it('never gives two customers the same number', async () => {
    const [a, b, c] = await Promise.all([makeCustomer(), makeCustomer(), makeCustomer()]);
    const opened = await Promise.all([
      susu.openAccount(officer, a, 1_000),
      susu.openAccount(officer, b, 1_000),
      susu.openAccount(officer, c, 1_000),
    ]);
    const stems = opened.map((o) => bareAccountNumber(o.accountNumber));
    expect(new Set(stems).size).toBe(3);
  });

  it('stores the number on the customer, and spends one sequence value per customer', async () => {
    const customerId = await makeCustomer();
    const before = (await CounterModel.findById(`SU-${period}`))?.seq ?? 0;
    const first = await susu.openAccount(officer, customerId, 1_000);
    await susu.openAccount(officer, customerId, 1_000);
    await susu.openAccount(officer, customerId, 1_000);
    const after = (await CounterModel.findById(`SU-${period}`))?.seq ?? 0;

    // Three books, one number, one counter value — not three.
    expect(after - before).toBe(1);
    const customer = await CustomerModel.findById(customerId);
    expect(customer?.susuNumber).toBe(bareAccountNumber(first.accountNumber));
  });

  it('leaves the accountNumber index in place, and non-unique', async () => {
    // Both halves matter: a surviving unique flag rejects a customer's second
    // book outright, and dropping the index with it turns every account-number
    // search into a collection scan.
    const indexes = await SusuAccountModel.collection.indexes();
    const onNumber = indexes.filter((i) => i.key.accountNumber === 1);
    expect(onNumber.length).toBeGreaterThan(0);
    expect(onNumber.every((i) => i.unique !== true)).toBe(true);
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
    // Savings counts from its own counter, so opening susu accounts above did
    // not advance it.
    const susuCounter = await CounterModel.findById(`SU-${period}`);
    const savingsCounter = await CounterModel.findById(`SV-${period}`);
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

  it('restarts the sequence in a new month', async () => {
    const august = new Date('2026-08-15T00:00:00.000Z');
    const september = new Date('2026-09-15T00:00:00.000Z');

    const aug1 = await nextAccountNumber('HP', august);
    const aug2 = await nextAccountNumber('HP', august);
    const sep1 = await nextAccountNumber('HP', september);

    expect(aug1).toBe('HP26080001');
    expect(aug2).toBe('HP26080002');
    // September starts over at 1 — the YYMM segment is what keeps it unique.
    expect(sep1).toBe('HP26090001');
  });

  it('never reissues a number a backfill already used', async () => {
    await raiseCounter('LN', '2501', 40);
    expect(await nextAccountNumber('LN', new Date('2025-01-10T00:00:00.000Z'))).toBe('LN25010041');

    // raiseCounter only moves the counter up, so re-running a migration is safe.
    await raiseCounter('LN', '2501', 10);
    expect(await nextAccountNumber('LN', new Date('2025-01-10T00:00:00.000Z'))).toBe('LN25010042');
  });

  it('still accepts grandfathered all-digit numbers', async () => {
    const customerId = await makeCustomer();
    // The shapes that existed before the scheme: 6 digits for susu, 10 for savings.
    const legacySusu = await SusuAccountModel.create({
      accountNumber: '482913',
      customerId,
      dailyAmount: 1_000,
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
        dailyAmount: 1_000,
        openedById: new Types.ObjectId(),
      }),
    ).rejects.toThrow();
  });
});
