import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import {
  CounterModel,
  CustomerModel,
  LoanModel,
  SavingsAccountModel,
  SusuAccountModel,
} from '../../src/models/index.js';
import { accountPeriodKey, nextAccountNumber } from '../../src/lib/account-number.js';
import { continueAccountNumbers } from '../../src/scripts/continue-account-numbers.js';
import { makeCustomer, setupDb, teardownDb } from './helpers.js';

beforeAll(setupDb);
afterAll(teardownDb);

const staff = new Types.ObjectId();
const now = new Date();
const thisPeriod = accountPeriodKey(now);
// The month before this one, as `YYMM`.
const lastPeriod = accountPeriodKey(new Date(now.getFullYear(), now.getMonth() - 1, 15));

async function savings(number: string, createdAt: Date): Promise<Types.ObjectId> {
  const id = new Types.ObjectId();
  await SavingsAccountModel.collection.insertOne({
    _id: id,
    accountNumber: number,
    customerId: await makeCustomer(),
    balance: 0,
    status: 'active',
    openedById: staff,
    deletedAt: null,
    createdAt,
    updatedAt: createdAt,
  });
  return id;
}

describe('account numbers run on across months', () => {
  it('renumbers this month’s restarted numbers after last month’s highest, and sets the counter', async () => {
    const ago = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    await savings(`SV${lastPeriod}0359`, ago(40));
    await savings(`SV${lastPeriod}0360`, ago(35));
    const first = await savings(`SV${thisPeriod}0001`, ago(0.2));
    const second = await savings(`SV${thisPeriod}0002`, ago(0.1));

    const dry = await continueAccountNumbers(false, now);
    expect(dry.products['SV']).toMatchObject({ renumbered: 2, counter: 362 });
    expect((await SavingsAccountModel.findById(first))?.accountNumber).toBe(`SV${thisPeriod}0001`);

    const applied = await continueAccountNumbers(true, now);
    expect(applied.products['SV']).toMatchObject({ renumbered: 2, counter: 362 });
    expect((await SavingsAccountModel.findById(first))?.accountNumber).toBe(`SV${thisPeriod}0361`);
    expect((await SavingsAccountModel.findById(second))?.accountNumber).toBe(`SV${thisPeriod}0362`);
    // Last month's numbers are untouched: they are on receipts.
    expect(await SavingsAccountModel.countDocuments({ accountNumber: `SV${lastPeriod}0360` })).toBe(
      1,
    );

    // The next account carries on, and the counter is the product's, not the month's.
    expect(await nextAccountNumber('SV', now)).toBe(`SV${thisPeriod}0363`);
    expect((await CounterModel.findById('SV'))?.seq).toBe(363);

    // Running it again finds nothing to renumber, and never lowers the counter:
    // 0363 was reserved above though no account was written under it.
    const again = await continueAccountNumbers(true, now);
    expect(again.products['SV']).toMatchObject({ renumbered: 0, counter: 362 });
    expect((await CounterModel.findById('SV'))?.seq).toBe(363);
  });

  it('can renumber only the accounts named, leaving the rest of the month alone', async () => {
    const ago = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    // Loans: last month reached 0007; this month restarted with two.
    await LoanModel.collection.insertOne({
      accountNumber: `LN${lastPeriod}0007`,
      customerId: await makeCustomer(),
      status: 'pending',
      createdAt: ago(40),
      updatedAt: ago(40),
    });
    const keep = new Types.ObjectId();
    const change = new Types.ObjectId();
    await LoanModel.collection.insertOne({
      _id: keep,
      accountNumber: `LN${thisPeriod}0001`,
      customerId: await makeCustomer(),
      status: 'pending',
      createdAt: ago(0.3),
      updatedAt: ago(0.3),
    });
    await LoanModel.collection.insertOne({
      _id: change,
      accountNumber: `LN${thisPeriod}0002`,
      customerId: await makeCustomer(),
      status: 'pending',
      createdAt: ago(0.2),
      updatedAt: ago(0.2),
    });

    const r = await continueAccountNumbers(true, now, [`LN${thisPeriod}0002`]);
    expect(r.products['LN']).toMatchObject({ renumbered: 1, counter: 8 });
    expect((await LoanModel.findById(change))?.accountNumber).toBe(`LN${thisPeriod}0008`);
    expect((await LoanModel.findById(keep))?.accountNumber).toBe(`LN${thisPeriod}0001`);
  });

  it('moves a susu number on the customer along with the account', async () => {
    const customerId = await makeCustomer();
    await SusuAccountModel.collection.insertOne({
      accountNumber: `SU${lastPeriod}0012`,
      customerId: await makeCustomer(),
      balance: 0,
      status: 'active',
      openedById: staff,
      deletedAt: null,
      createdAt: new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000),
      updatedAt: now,
    });
    await SusuAccountModel.collection.insertOne({
      accountNumber: `SU${thisPeriod}0001`,
      customerId,
      balance: 0,
      status: 'active',
      openedById: staff,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await CustomerModel.updateOne(
      { _id: customerId },
      { $set: { susuNumber: `SU${thisPeriod}0001` } },
    );

    await continueAccountNumbers(true, now);
    expect((await SusuAccountModel.findOne({ customerId }))?.accountNumber).toBe(
      `SU${thisPeriod}0013`,
    );
    expect((await CustomerModel.findById(customerId))?.susuNumber).toBe(`SU${thisPeriod}0013`);
  });
});
