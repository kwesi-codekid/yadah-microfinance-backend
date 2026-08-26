import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { SusuAccountModel, SusuPayoutModel } from '../../src/models/index.js';
import * as susu from '../../src/modules/susu/susu.service.js';
import { asOfficer, makeCustomer, setupDb, teardownDb } from './helpers.js';

beforeAll(setupDb);
afterAll(teardownDb);

const officer = asOfficer();
const DAILY = 1_000; // GHS 10

/** Opens an account and pays `days` deposits into it. */
async function accountWithDeposits(days: number): Promise<Types.ObjectId> {
  const customerId = await makeCustomer();
  const account = await susu.openAccount(officer, customerId, DAILY);
  const id = new Types.ObjectId(account.id);
  if (days > 0) {
    await susu.recordDeposit(officer, id, DAILY * days, randomUUID(), 'cash');
  }
  return id;
}

/**
 * Partial withdrawal (client decision 2026-08-21): taking money no longer
 * closes the account, no commission is charged on the way out, and the cycle
 * keeps its progress.
 */
describe('partial susu withdrawal', () => {
  it('takes money and leaves the account running, with the cycle untouched', async () => {
    const id = await accountWithDeposits(10); // 10,000 in

    const result = await susu.withdrawPartial(officer, id, 4_000, randomUUID());
    expect(result.amount).toBe(4_000);
    expect(result.account.status).toBe('active');
    expect(result.account.balance).toBe(6_000);
    expect(result.account.withdrawnAmount).toBe(4_000);
    // Days already paid stay paid — withdrawing money is not un-depositing.
    expect(result.account.depositsCount).toBe(10);
    expect(result.account.totalDeposited).toBe(10_000);
  });

  it('reserves exactly one day so the closing commission stays collectible', async () => {
    const id = await accountWithDeposits(10);
    const account = await susu.getAccount(officer, id);
    expect(account.availableToWithdraw).toBe(9_000); // 10,000 − one day

    await expect(susu.withdrawPartial(officer, id, 9_001, randomUUID())).rejects.toMatchObject({
      code: 'EXCEEDS_AVAILABLE',
      status: 422,
    });

    // Exactly the available amount is fine, and leaves the reserve behind.
    const ok = await susu.withdrawPartial(officer, id, 9_000, randomUUID());
    expect(ok.account.balance).toBe(DAILY);
    expect(ok.account.availableToWithdraw).toBe(0);

    await expect(susu.withdrawPartial(officer, id, 1, randomUUID())).rejects.toMatchObject({
      code: 'EXCEEDS_AVAILABLE',
    });
  });

  it('charges commission once at closure, not per withdrawal', async () => {
    const id = await accountWithDeposits(20); // 20,000 in

    await susu.withdrawPartial(officer, id, 5_000, randomUUID());
    await susu.withdrawPartial(officer, id, 5_000, randomUUID());
    await susu.withdrawPartial(officer, id, 5_000, randomUUID());

    const closure = await susu.closeAccount(officer, id);
    expect(closure.commission).toBe(DAILY); // one day, not three
    expect(closure.payout).toBe(4_000); // 5,000 balance − 1,000 commission
    expect(closure.flagged).toBe(false);
  });

  it('records the cash leaving so it shows in the transactions feed', async () => {
    const id = await accountWithDeposits(10);
    await susu.withdrawPartial(officer, id, 3_000, randomUUID());

    const rows = await SusuPayoutModel.find({ accountId: id });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('partial-withdrawal');
    expect(rows[0]?.amount).toBe(3_000);
    expect(rows[0]?.destination).toBe('cash');
  });

  it('replays a retried request without taking the money twice', async () => {
    const id = await accountWithDeposits(10);
    const key = randomUUID();

    const first = await susu.withdrawPartial(officer, id, 2_000, key);
    const replay = await susu.withdrawPartial(officer, id, 2_000, key);

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.amount).toBe(2_000);

    const account = await SusuAccountModel.findById(id);
    expect(account?.withdrawnAmount).toBe(2_000); // not 4,000
    expect(await SusuPayoutModel.countDocuments({ accountId: id })).toBe(1);
  });

  it('refuses a withdrawal from an account that is no longer open', async () => {
    const id = await accountWithDeposits(10);
    await susu.closeAccount(officer, id);

    await expect(susu.withdrawPartial(officer, id, 1_000, randomUUID())).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_OPEN',
      status: 422,
    });
  });

  it('leaves nothing behind when the withdrawal is refused', async () => {
    const id = await accountWithDeposits(5); // 5,000 in, 4,000 available

    await expect(susu.withdrawPartial(officer, id, 4_500, randomUUID())).rejects.toMatchObject({
      code: 'EXCEEDS_AVAILABLE',
    });

    const account = await SusuAccountModel.findById(id);
    expect(account?.withdrawnAmount).toBe(0);
    expect(await SusuPayoutModel.countDocuments({ accountId: id })).toBe(0);
  });

  it('still allows deposits after a withdrawal, continuing the same cycle', async () => {
    const id = await accountWithDeposits(10);
    await susu.withdrawPartial(officer, id, 5_000, randomUUID());

    const after = await susu.recordDeposit(officer, id, DAILY * 2, randomUUID(), 'cash');
    expect(after.account.depositsCount).toBe(12);
    expect(after.account.totalDeposited).toBe(12_000);
    expect(after.account.balance).toBe(7_000); // 12,000 in − 5,000 out
  });
});
