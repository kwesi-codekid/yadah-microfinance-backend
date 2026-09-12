import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { bareAccountNumber, cycleMonthOf } from '../../src/lib/account-number.js';
import { SUSU_CYCLE_DEPOSITS } from '../../src/domain/susu.js';
import { SusuAccountModel, SusuDepositModel } from '../../src/models/index.js';
import * as susu from '../../src/modules/susu/susu.service.js';
import { asOfficer, makeCustomer, setupDb, teardownDb } from './helpers.js';

beforeAll(setupDb);
afterAll(teardownDb);

const officer = asOfficer();
const DAILY = 1_000; // GHS 10

/** Open an account and pay `days` into it, without overflowing. */
async function accountWith(
  days: number,
): Promise<{ customerId: Types.ObjectId; id: Types.ObjectId }> {
  const customerId = await makeCustomer();
  const account = await susu.openAccount(officer, customerId, DAILY);
  const id = new Types.ObjectId(account.id);
  if (days > 0) {
    await susu.recordDeposit(officer, id, DAILY * days, randomUUID(), 'cash');
  }
  return { customerId, id };
}

describe('susu carry-forward', () => {
  it('records a payment that fits as one leg, exactly as before', async () => {
    const { id } = await accountWith(5);
    const result = await susu.recordDeposit(officer, id, DAILY * 10, randomUUID(), 'cash');

    expect(result.legs).toHaveLength(1);
    expect(result.openedAccounts).toEqual([]);
    expect(result.totalAmount).toBe(DAILY * 10);
    expect(result.deposit.seqStart).toBe(6);
    expect(result.deposit.seqEnd).toBe(15);
    expect(result.account.depositsCount).toBe(15);
  });

  it('fills the cycle and carries the remainder into a new account', async () => {
    const { customerId, id } = await accountWith(5);
    // 40 days against a cycle with 26 left: 26 here, 14 in a new account.
    const result = await susu.recordDeposit(officer, id, DAILY * 40, randomUUID(), 'cash');

    expect(result.totalAmount).toBe(DAILY * 40);
    expect(result.legs).toHaveLength(2);
    expect(result.openedAccounts).toHaveLength(1);

    const [head, tail] = result.legs;
    expect(head?.carried).toBe(false);
    expect(head?.deposit.daysCovered).toBe(26);
    expect(head?.deposit.seqEnd).toBe(SUSU_CYCLE_DEPOSITS);
    expect(head?.account.status).toBe('completed');
    expect(head?.account.depositsCount).toBe(SUSU_CYCLE_DEPOSITS);

    expect(tail?.carried).toBe(true);
    expect(tail?.deposit.daysCovered).toBe(14);
    expect(tail?.deposit.seqStart).toBe(1);
    expect(tail?.deposit.seqEnd).toBe(14);
    expect(tail?.account.status).toBe('active');
    expect(tail?.account.dailyAmount).toBe(DAILY);
    expect(tail?.account.carriedFromAccountId).toBe(id.toHexString());

    // Every pesewa landed somewhere.
    const deposits = await SusuDepositModel.find({ customerId });
    expect(deposits.reduce((n, d) => n + d.amount, 0)).toBe(DAILY * 45); // 5 + 40

    // Both accounts belong to the same customer, and only two exist.
    expect(await SusuAccountModel.countDocuments({ customerId })).toBe(2);
  });

  it('numbers the carried account with the CURRENT month, not the old cycle’s', async () => {
    const customerId = await makeCustomer();
    // The parent is deliberately opened for a different month.
    const parent = await susu.openAccount(officer, customerId, DAILY, 'JAN');
    expect(parent.accountNumber.endsWith('-JAN')).toBe(true);

    const id = new Types.ObjectId(parent.id);
    const result = await susu.recordDeposit(
      officer,
      id,
      DAILY * (SUSU_CYCLE_DEPOSITS + 3),
      randomUUID(),
      'cash',
    );

    const opened = result.openedAccounts[0];
    expect(opened?.cycleMonth).toBe(cycleMonthOf());
    expect(opened?.accountNumber.endsWith(`-${cycleMonthOf()}`)).toBe(true);
    // Same customer, so the same number underneath: only the month moved. The
    // parent is a JAN book, so here the two strings still differ — open one in
    // the current month and they are identical, which is the point.
    expect(bareAccountNumber(opened?.accountNumber ?? '')).toBe(
      bareAccountNumber(parent.accountNumber),
    );
  });

  it('gives an overflow inside the same month the parent’s exact number', async () => {
    const customerId = await makeCustomer();
    const parent = await susu.openAccount(officer, customerId, DAILY);
    const result = await susu.recordDeposit(
      officer,
      new Types.ObjectId(parent.id),
      DAILY * (SUSU_CYCLE_DEPOSITS + 3),
      randomUUID(),
      'cash',
    );

    // The ordinary case: a book fills up and the balance starts the next one
    // in the same month. Both are the customer's, so both read identically —
    // which the unique index used to make impossible.
    const opened = result.openedAccounts[0];
    expect(opened?.accountNumber).toBe(parent.accountNumber);
    expect(opened?.id).not.toBe(parent.id);
    expect(opened?.ref).not.toBe(parent.ref);
  });

  it('links the two halves both ways', async () => {
    const { id } = await accountWith(30);
    const result = await susu.recordDeposit(officer, id, DAILY * 5, randomUUID(), 'cash');

    const [head, tail] = result.legs;
    expect(head?.deposit.carriedToDepositId).toBe(tail?.deposit.id);
    expect(head?.deposit.carriedToAccountId).toBe(tail?.account.id);
    expect(tail?.deposit.carriedFromDepositId).toBe(head?.deposit.id);
    expect(tail?.deposit.carriedFromAccountId).toBe(head?.account.id);
  });

  it('refuses an amount that would open more than one account', async () => {
    const { customerId, id } = await accountWith(5);
    // 100 days: 26 + 31 + 31 + 12 — three new accounts, almost certainly a typo.
    await expect(
      susu.recordDeposit(officer, id, DAILY * 100, randomUUID(), 'cash'),
    ).rejects.toMatchObject({ code: 'EXCEEDS_CARRY_LIMIT' });

    // Nothing was written, and no number was burned into a real account.
    expect(await SusuAccountModel.countDocuments({ customerId })).toBe(1);
    expect(await SusuDepositModel.countDocuments({ customerId })).toBe(1);
  });

  it('replays a carried payment in full rather than paying it twice', async () => {
    const { customerId, id } = await accountWith(5);
    const key = randomUUID();
    const first = await susu.recordDeposit(officer, id, DAILY * 40, key, 'cash');
    const replay = await susu.recordDeposit(officer, id, DAILY * 40, key, 'cash');

    expect(replay.replayed).toBe(true);
    expect(replay.legs).toHaveLength(2);
    expect(replay.totalAmount).toBe(first.totalAmount);
    expect(replay.legs.map((l) => l.deposit.id)).toEqual(first.legs.map((l) => l.deposit.id));

    // Still two accounts and three deposits (the opening 5-day one plus two legs).
    expect(await SusuAccountModel.countDocuments({ customerId })).toBe(2);
    expect(await SusuDepositModel.countDocuments({ customerId })).toBe(3);
  });

  it('refuses to correct the half that carried until the carried half is gone', async () => {
    const { id } = await accountWith(5);
    const result = await susu.recordDeposit(officer, id, DAILY * 40, randomUUID(), 'cash');
    const head = result.legs[0];
    const tail = result.legs[1];

    await expect(
      susu.trashDeposit(officer, id, new Types.ObjectId(head?.deposit.id), 'mistake'),
    ).rejects.toMatchObject({ code: 'CANNOT_TRASH' });

    // Removing the carried half first releases the parent.
    await susu.trashDeposit(
      officer,
      new Types.ObjectId(tail?.account.id),
      new Types.ObjectId(tail?.deposit.id),
      'mistake',
    );
    const releasedParent = await SusuDepositModel.findById(head?.deposit.id);
    expect(releasedParent?.carriedToDepositId).toBeUndefined();

    const trashed = await susu.trashDeposit(
      officer,
      id,
      new Types.ObjectId(head?.deposit.id),
      'mistake',
    );
    expect(trashed.account.depositsCount).toBe(5);
  });

  it('an exactly-filling payment does not open an account', async () => {
    const { customerId, id } = await accountWith(5);
    const result = await susu.recordDeposit(officer, id, DAILY * 26, randomUUID(), 'cash');

    expect(result.openedAccounts).toEqual([]);
    expect(result.account.status).toBe('completed');
    expect(await SusuAccountModel.countDocuments({ customerId })).toBe(1);
  });
});
