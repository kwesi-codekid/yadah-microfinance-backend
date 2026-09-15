import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { SavingsAccountModel, SavingsTxnModel, SusuDepositModel } from '../../src/models/index.js';
import { MIN_BALANCE, WITHDRAWAL_FEE } from '../../src/domain/savings.js';
import * as savings from '../../src/modules/savings/savings.service.js';
import * as susu from '../../src/modules/susu/susu.service.js';
import type { AccessTokenPayload } from '../../src/modules/auth/auth.service.js';
import { asOfficer, makeCollector, makeCustomer, setupDb, teardownDb } from './helpers.js';

/**
 * Recording a transaction on the day it actually happened — the stopgap for
 * the data-population stage.
 *
 * Two things are being checked. That a backdated transaction lands on the day
 * it names, everywhere that reads a day. And that a savings statement stays
 * true when one is threaded into the middle of it: the running balance is a
 * column people read down, and a row inserted underneath it has to move every
 * figure below.
 */

beforeAll(setupDb);
afterAll(teardownDb);

const officer = asOfficer();
let collector: AccessTokenPayload;

beforeAll(async () => {
  collector = await makeCollector('Backdating Collector');
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** An Accra day a given number of days before today. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);
}

/** An account's live statement, oldest first — the order a reader sees. */
async function statement(accountId: Types.ObjectId) {
  const rows = await SavingsTxnModel.find({ accountId, deletedAt: null }).sort({
    createdAt: 1,
    _id: 1,
  });
  return rows.map((r) => ({ amount: r.amount, balanceAfter: r.balanceAfter, day: r.accraDay }));
}

/* --------------------------------------------------------------- the susu --- */

describe('a susu deposit dated to the day it was taken', () => {
  it('lands on that day in the summary, not the day it was typed', async () => {
    const customerId = await makeCustomer();
    const account = await susu.openAccount(officer, customerId, 1_000);
    const accountId = new Types.ObjectId(account.id);
    const when = daysAgo(4);

    const result = await susu.recordDeposit(
      officer,
      accountId,
      2_000,
      randomUUID(),
      'cash',
      undefined,
      when,
    );

    // The row itself carries the day it happened.
    const deposit = await SusuDepositModel.findById(result.deposit.id);
    expect(deposit?.createdAt.toISOString().slice(0, 10)).toBe(when);
    // …and the moment it was really typed survives on the id, which is not
    // the typist's to edit.
    expect(deposit?._id.getTimestamp().getTime()).toBeGreaterThan(Date.now() - 60_000);

    // The day's collection sheet finds it; today's does not.
    const thatDay = await susu.dailySummary(officer, { date: when });
    expect(thatDay.deposits.map((d) => d.depositId)).toContain(result.deposit.id);
    expect(thatDay.totalCollected).toBe(2_000);

    const today = await susu.dailySummary(officer, { date: daysAgo(0) });
    expect(today.deposits.map((d) => d.depositId)).not.toContain(result.deposit.id);

    // The cycle itself is unmoved: the days are a sequence, not a calendar.
    expect(result.deposit.seqStart).toBe(1);
    expect(result.deposit.seqEnd).toBe(2);
    expect(result.account.depositsCount).toBe(2);
  });

  it('dates a whole collect-all round', async () => {
    const customerId = await makeCustomer();
    await susu.openAccount(officer, customerId, 1_000);
    await susu.openAccount(officer, customerId, 2_000);
    const when = daysAgo(6);

    await susu.collectAll(officer, customerId, 3_000, randomUUID(), 'cash', undefined, when);

    const deposits = await SusuDepositModel.find({ customerId });
    expect(deposits).toHaveLength(2);
    expect(deposits.every((d) => d.createdAt.toISOString().slice(0, 10) === when)).toBe(true);

    const summary = await susu.dailySummary(officer, { date: when });
    expect(summary.totalCollected).toBe(3_000);
  });

  it('is refused for a collector, whose day is the one being reconciled', async () => {
    const customerId = await makeCustomer(false, new Types.ObjectId(collector.sub));
    const account = await susu.openAccount(officer, customerId, 1_000);

    await expect(
      susu.recordDeposit(
        collector,
        new Types.ObjectId(account.id),
        1_000,
        randomUUID(),
        'cash',
        undefined,
        daysAgo(2),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    // Their ordinary collection, dated today, is untouched.
    const ok = await susu.recordDeposit(
      collector,
      new Types.ObjectId(account.id),
      1_000,
      randomUUID(),
      'cash',
    );
    expect(ok.deposit.amount).toBe(1_000);
  });
});

/* ------------------------------------------------------------ the savings --- */

describe('a savings transaction threaded into the statement', () => {
  it('puts a backdated deposit in its place and moves every figure below it', async () => {
    const customerId = await makeCustomer();
    const opened = await savings.openAccount(officer, customerId, 10_000, randomUUID(), 'cash');
    const accountId = new Types.ObjectId(opened.account.id);

    // Two deposits typed in for days before the account was keyed in at all.
    await savings.deposit(officer, accountId, 2_000, randomUUID(), 'cash', undefined, daysAgo(5));
    await savings.deposit(officer, accountId, 3_000, randomUUID(), 'cash', undefined, daysAgo(3));

    // Read down the column: each row is the one above it plus what came in.
    expect(await statement(accountId)).toEqual([
      { amount: 2_000, balanceAfter: 2_000, day: daysAgo(5) },
      { amount: 3_000, balanceAfter: 5_000, day: daysAgo(3) },
      { amount: 10_000, balanceAfter: 15_000, day: daysAgo(0) },
    ]);
    expect((await SavingsAccountModel.findById(accountId))?.balance).toBe(15_000);
  });

  it('judges a backdated withdrawal by what the account held that day', async () => {
    const customerId = await makeCustomer();
    const opened = await savings.openAccount(officer, customerId, 50_000, randomUUID(), 'cash');
    const accountId = new Types.ObjectId(opened.account.id);
    await savings.deposit(officer, accountId, 20_000, randomUUID(), 'cash', undefined, daysAgo(5));

    // On that day the account held 20,000, so the minimum balance and the fee
    // are taken out of THAT, not out of the 70,000 it holds now.
    const available = 20_000 - MIN_BALANCE - WITHDRAWAL_FEE;
    await expect(
      savings.withdraw(officer, accountId, available + 1, randomUUID(), undefined, daysAgo(3)),
    ).rejects.toMatchObject({ code: 'EXCEEDS_AVAILABLE', status: 422 });

    await savings.withdraw(officer, accountId, 5_000, randomUUID(), undefined, daysAgo(3));

    expect(await statement(accountId)).toEqual([
      { amount: 20_000, balanceAfter: 20_000, day: daysAgo(5) },
      { amount: 5_000, balanceAfter: 20_000 - 5_000 - WITHDRAWAL_FEE, day: daysAgo(3) },
      { amount: 50_000, balanceAfter: 70_000 - 5_000 - WITHDRAWAL_FEE, day: daysAgo(0) },
    ]);
    expect((await SavingsAccountModel.findById(accountId))?.balance).toBe(
      70_000 - 5_000 - WITHDRAWAL_FEE,
    );
  });

  it('refuses a withdrawal that would overdraw the account later in its history', async () => {
    const customerId = await makeCustomer();
    const opened = await savings.openAccount(officer, customerId, 50_000, randomUUID(), 'cash');
    const accountId = new Types.ObjectId(opened.account.id);
    await savings.deposit(officer, accountId, 20_000, randomUUID(), 'cash', undefined, daysAgo(5));
    // Leaves the account on exactly the minimum balance three days ago.
    await savings.withdraw(officer, accountId, 18_000, randomUUID(), undefined, daysAgo(3));
    const before = await statement(accountId);
    expect(before[1]?.balanceAfter).toBe(MIN_BALANCE);

    // Squeezing another withdrawal in between would put that row underwater.
    await expect(
      savings.withdraw(officer, accountId, 2_000, randomUUID(), undefined, daysAgo(4)),
    ).rejects.toMatchObject({ code: 'BACKDATE_OVERDRAWS', status: 422 });

    // Nothing moved.
    expect(await statement(accountId)).toEqual(before);
  });

  it('keeps one withdrawal per day on the day it is dated', async () => {
    const customerId = await makeCustomer();
    const opened = await savings.openAccount(officer, customerId, 50_000, randomUUID(), 'cash');
    const accountId = new Types.ObjectId(opened.account.id);
    // Money has to be in the account on the day being withdrawn from: the
    // opening deposit is dated today, so a week ago it held nothing.
    await savings.deposit(officer, accountId, 50_000, randomUUID(), 'cash', undefined, daysAgo(5));

    await savings.withdraw(officer, accountId, 1_000, randomUUID(), undefined, daysAgo(2));
    await expect(
      savings.withdraw(officer, accountId, 1_000, randomUUID(), undefined, daysAgo(2)),
    ).rejects.toMatchObject({ code: 'WITHDRAWAL_LIMIT', status: 409 });

    // A different day is a different slot, and today's is still free.
    await savings.withdraw(officer, accountId, 1_000, randomUUID(), undefined, daysAgo(1));
    await savings.withdraw(officer, accountId, 1_000, randomUUID());
  });

  it('leaves an ordinary same-day transaction exactly as it was', async () => {
    const customerId = await makeCustomer();
    const opened = await savings.openAccount(officer, customerId, 10_000, randomUUID(), 'cash');
    const accountId = new Types.ObjectId(opened.account.id);

    await savings.deposit(officer, accountId, 4_000, randomUUID(), 'cash');
    const wd = await savings.withdraw(officer, accountId, 2_000, randomUUID());

    expect(wd.txn.accraDay).toBe(daysAgo(0));
    expect(await statement(accountId)).toEqual([
      { amount: 10_000, balanceAfter: 10_000, day: daysAgo(0) },
      { amount: 4_000, balanceAfter: 14_000, day: daysAgo(0) },
      { amount: 2_000, balanceAfter: 14_000 - 2_000 - WITHDRAWAL_FEE, day: daysAgo(0) },
    ]);
  });
});
