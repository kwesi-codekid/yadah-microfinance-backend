import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WITHDRAWAL_FEE, earliestMaturity } from '../../src/domain/savings.js';
import { accraDay } from '../../src/lib/time.js';
import { CustomerModel, SavingsAccountModel } from '../../src/models/index.js';
import * as savings from '../../src/modules/savings/savings.service.js';
import { openAccountBody } from '../../src/modules/savings/savings.schemas.js';
import { asOfficer, makeCustomer, setupDb, teardownDb } from './helpers.js';

beforeAll(setupDb);
afterAll(teardownDb);

const officer = asOfficer();

/** A birth date `years` years before today. */
function bornYearsAgo(years: number): Date {
  const today = accraDay();
  return new Date(`${String(Number(today.slice(0, 4)) - years)}${today.slice(4)}T00:00:00.000Z`);
}

async function person(years: number): Promise<Types.ObjectId> {
  const id = await makeCustomer();
  await CustomerModel.updateOne(
    { _id: id },
    { $set: { dateOfBirth: bornYearsAgo(years), isMinor: years < 18 } },
  );
  return id;
}

function dayOffset(days: number): string {
  const d = new Date(`${accraDay()}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return accraDay(d);
}

const SIX_MONTHS = earliestMaturity(accraDay());

async function openFixed(
  child: Types.ObjectId,
  guardian: Types.ObjectId,
  deposit = 50_000,
  termMonths = 6,
) {
  const { account } = await savings.openAccount(
    officer,
    child,
    deposit,
    randomUUID(),
    'cash',
    'fixed',
    undefined,
    { guardianId: guardian, termMonths },
  );
  return new Types.ObjectId(account.id);
}

/** Moves the maturity day, as the calendar would. */
async function maturesOn(accountId: Types.ObjectId, day: string): Promise<void> {
  await SavingsAccountModel.updateOne({ _id: accountId }, { $set: { maturesOn: day } });
}

describe('opening a fixed deposit', () => {
  it('opens for a child with an adult guardian, on a term of six months or more', async () => {
    const [child, mum] = [await person(8), await person(35)];
    const sixMonths = await savings.getAccount(officer, await openFixed(child, mum));
    expect(sixMonths).toMatchObject({ termMonths: 6, maturesOn: SIX_MONTHS });
    const id = await openFixed(child, mum, 50_000, 12);
    const account = await savings.getAccount(officer, id);
    expect(account).toMatchObject({
      accountType: 'fixed',
      termMonths: 12,
      matured: false,
      guardianId: mum.toHexString(),
      availableToWithdraw: 50_000 - 2_000,
    });
    expect(account.guardianName).toBeTruthy();
  });

  it('refuses a term under six months', async () => {
    const [child, mum] = [await person(8), await person(35)];
    await expect(openFixed(child, mum, 50_000, 3)).rejects.toMatchObject({
      code: 'TERM_TOO_SHORT',
    });
  });

  it('is for children only', async () => {
    const [adult, mum] = [await person(20), await person(45)];
    await expect(openFixed(adult, mum)).rejects.toMatchObject({
      code: 'FIXED_DEPOSIT_CHILDREN_ONLY',
    });
  });

  it('needs an adult guardian who is not the child', async () => {
    const [child, sibling] = [await person(8), await person(12)];
    await expect(openFixed(child, sibling)).rejects.toMatchObject({ code: 'GUARDIAN_INVALID' });
    await expect(openFixed(child, child)).rejects.toMatchObject({ code: 'GUARDIAN_INVALID' });
  });

  it('asks for the guardian and date on a fixed deposit, and nowhere else', () => {
    const base = { customerId: new Types.ObjectId().toHexString(), channel: 'cash' };
    expect(openAccountBody.safeParse({ ...base, accountType: 'fixed' }).success).toBe(false);
    expect(
      openAccountBody.safeParse({ ...base, accountType: 'standard', termMonths: 6 }).success,
    ).toBe(false);
  });
});

describe('money in and out', () => {
  it('takes deposits all through the term', async () => {
    const id = await openFixed(await person(8), await person(35), 10_000);
    const { account } = await savings.deposit(officer, id, 5_000, randomUUID(), 'cash');
    expect(account.balance).toBe(15_000);
  });

  it('charges the normal fee the day before maturity', async () => {
    const id = await openFixed(await person(8), await person(35));
    await maturesOn(id, dayOffset(1));
    const { txn, account } = await savings.withdraw(officer, id, 5_000, randomUUID());
    expect(txn.fee).toBe(WITHDRAWAL_FEE);
    expect(account.balance).toBe(50_000 - 5_000 - WITHDRAWAL_FEE);
  });

  it('pays out everything, free, from the maturity day', async () => {
    const id = await openFixed(await person(8), await person(35));
    await maturesOn(id, accraDay());
    expect((await savings.getAccount(officer, id)).availableToWithdraw).toBe(50_000);
    const { txn, account } = await savings.withdraw(officer, id, 50_000, randomUUID());
    expect(txn.fee).toBe(0);
    expect(account.balance).toBe(0);
  });

  it('still takes deposits after maturity', async () => {
    const id = await openFixed(await person(8), await person(35), 10_000);
    await maturesOn(id, dayOffset(-10));
    const { account } = await savings.deposit(officer, id, 7_000, randomUUID(), 'cash');
    expect(account.balance).toBe(17_000);
    expect(account.matured).toBe(true);
  });

  it('closes free once matured, and for the normal fee before', async () => {
    const early = await openFixed(await person(8), await person(35));
    expect((await savings.closeAccount(officer, early)).fee).toBe(WITHDRAWAL_FEE);

    const due = await openFixed(await person(8), await person(35));
    await maturesOn(due, accraDay());
    expect(await savings.closeAccount(officer, due)).toMatchObject({ fee: 0, payout: 50_000 });
  });
});

describe('the parent’s side', () => {
  it('lists the fixed deposits a parent is guardian to', async () => {
    const mum = await person(35);
    await openFixed(await person(8), mum);
    await openFixed(await person(5), mum);
    const list = await savings.listAccounts(officer, {
      guardianId: mum,
      page: 1,
      limit: 20,
    } as never);
    expect(list.total).toBe(2);
    expect(list.items.every((a) => a.accountType === 'fixed')).toBe(true);
  });
});
