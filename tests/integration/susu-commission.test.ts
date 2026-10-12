import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import {
  SusuAccountModel,
  CommissionModel,
  SusuCycleModel,
  SusuPayoutModel,
  SusuPlanModel,
  SmsLogModel,
} from '../../src/models/index.js';
import { commissionEarned } from '../../src/modules/reports/reports.service.js';
import { backfillCommissions } from '../../src/modules/commissions/commissions.backfill.js';
import * as commissions from '../../src/modules/commissions/commissions.service.js';
import * as susu from '../../src/modules/susu/susu.service.js';
import { asOfficer, makeCustomer, setupDb, teardownDb } from './helpers.js';

beforeAll(setupDb);
afterAll(teardownDb);

const officer = asOfficer();
const oid = (id: string): Types.ObjectId => new Types.ObjectId(id);

async function accountWith(daily: number, payments = 0) {
  const customerId = await makeCustomer();
  const { account } = await susu.openAccount(officer, customerId, daily);
  const accountId = oid(account.id);
  const planId = oid(account.plans[0]!.id);
  if (payments > 0) {
    await pay(accountId, planId.toHexString(), daily, payments);
  }
  return { customerId, accountId, planId };
}

function pay(accountId: Types.ObjectId, planId: string, daily: number, payments: number) {
  return susu.recordDeposit(
    officer,
    accountId,
    daily * payments,
    randomUUID(),
    'cash',
    undefined,
    undefined,
    [{ planId, payments }],
  );
}

/**
 * Yadah's susu commission account (client decision, 7 Oct 2026): every
 * commission leaves the customer's balance into its own ledger.
 */
describe('the commission account', () => {
  it('the 31st payment moves one day to Yadah automatically, nothing withdrawn', async () => {
    const { accountId, planId } = await accountWith(2_500, 31);
    const a = await susu.getAccount(officer, accountId);
    expect(a.balance).toBe(2_500 * 30);

    const entries = await CommissionModel.find({ accountId });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      cycleNumber: 1,
      dailyAmount: 2_500,
      amount: 2_500,
      reason: 'cycle-completed',
    });
    expect(entries[0]?.planId.equals(planId)).toBe(true);
    const cycle = await SusuCycleModel.findOne({ planId });
    expect(entries[0]?.cycleId.equals(cycle!._id)).toBe(true);
  });

  it('stopping a plan and closing the account each file their commission', async () => {
    const { accountId, planId } = await accountWith(1_000, 4);
    const second = await susu.addPlan(officer, accountId, 3_000);
    await pay(accountId, second.plan.id, 3_000, 2);

    await susu.stopPlan(officer, accountId, planId);
    const closed = await susu.closeAccount(officer, accountId);

    const entries = await CommissionModel.find({ accountId }).sort({ takenAt: 1, _id: 1 });
    expect(entries.map((e) => [e.reason, e.amount])).toEqual([
      ['plan-stopped', 1_000],
      ['account-closed', 3_000],
    ]);
    expect(entries[1]?.payoutId?.toHexString()).toBe(closed.payoutId);
  });

  it('trashing the deposit that completed a cycle takes its commission back out', async () => {
    const { accountId } = await accountWith(1_000, 30);
    const r = await susu.recordDeposit(officer, accountId, 1_000, randomUUID(), 'cash');
    expect(await CommissionModel.countDocuments({ accountId })).toBe(1);

    await susu.trashDeposit(officer, accountId, oid(r.deposit.id), 'keyed twice');
    expect(await CommissionModel.countDocuments({ accountId })).toBe(0);
  });

  it('the commission report reads the ledger', async () => {
    const before = await commissionEarned();
    await accountWith(4_000, 31);
    const after = await commissionEarned();
    expect(after.susuCommission.amount - before.susuCommission.amount).toBe(4_000);
    expect(after.susuCommission.count - before.susuCommission.count).toBe(1);
  });

  it('lists entries with the total, newest first', async () => {
    const { accountId } = await accountWith(1_500, 31);
    const { accountNumber } = await susu.getAccount(officer, accountId);
    const list = await commissions.listCommissions({ page: 1, limit: 10, q: accountNumber });
    expect(list.total).toBe(1);
    expect(list.totals.amount).toBe(1_500);
    expect(list.items[0]).toMatchObject({
      source: 'susu',
      amount: 1_500,
      reason: 'cycle-completed',
      accountNumber,
    });
    expect(list.items[0]?.accountNumber).toBeDefined();
    expect(list.items[0]?.customerName).toBeDefined();
  });

  it('the backfill files cycles that have no entry yet, once', async () => {
    const { accountId } = await accountWith(2_000, 31);
    await CommissionModel.deleteMany({ accountId });

    const dry = await backfillCommissions(false);
    expect(dry.entries).toBeGreaterThanOrEqual(1);
    expect(await CommissionModel.countDocuments({ accountId })).toBe(0);

    await backfillCommissions(true);
    expect(await CommissionModel.countDocuments({ accountId })).toBe(1);
    expect((await backfillCommissions(true)).entries).toBe(0);
  });
});

describe('withdrawing everything', () => {
  it('partial withdrawals stop only where the commission could no longer be taken', async () => {
    const { accountId } = await accountWith(1_000, 5);
    await expect(susu.withdraw(officer, accountId, 4_500, randomUUID())).rejects.toMatchObject({
      code: 'EXCEEDS_AVAILABLE',
      details: { available: 4_000, locked: 1_000 },
    });
    const r = await susu.withdraw(officer, accountId, 3_000, randomUUID());
    expect(r.commission).toBe(0);
    expect(r.account.balance).toBe(2_000);
  });

  it('records who collected on the holder’s behalf, on a part and on everything', async () => {
    const collectedBy = { name: 'Kofi Boateng', phone: '0551234567' };
    const { accountId } = await accountWith(1_000, 5);

    const part = await susu.withdraw(
      officer,
      accountId,
      1_000,
      randomUUID(),
      undefined,
      collectedBy,
    );
    expect(await SusuPayoutModel.findById(part.payoutId)).toMatchObject({ collectedBy });
    const [listed] = (await susu.listAccountPayouts(officer, accountId, { page: 1, limit: 5 }))
      .items;
    expect(listed?.collectedBy).toEqual(collectedBy);

    const all = await susu.withdrawAll(officer, accountId, randomUUID(), undefined, collectedBy);
    expect(await SusuPayoutModel.findById(all.payoutId)).toMatchObject({ collectedBy });
    const sms = await SmsLogModel.find({ relatedEntityId: accountId, template: 'susu-withdrawal' });
    expect(sms.map((s) => s.message.includes('Collected by Kofi Boateng (0551234567).'))).toEqual([
      true,
      true,
    ]);
  });

  it('a withdrawal that leaves only commission moves it to Yadah and ends the cycle', async () => {
    const { accountId } = await accountWith(1_000, 5);
    const second = await susu.addPlan(officer, accountId, 2_500);
    await pay(accountId, second.plan.id, 2_500, 2);
    // 5,000 + 5,000 in; 1,000 + 2,500 commission due; take the 6,500 that is theirs.
    const r = await susu.withdraw(officer, accountId, 6_500, randomUUID());

    expect(r.commission).toBe(3_500);
    expect(r.account).toMatchObject({ balance: 0, locked: 0 });
    expect(r.account.plans.map((p) => [p.paidInCycle, p.cycleNumber, p.cyclesCompleted])).toEqual([
      [0, 2, 0],
      [0, 2, 0],
    ]);
    const entries = await CommissionModel.find({ accountId }).sort({ amount: 1 });
    expect(entries.map((e) => [e.reason, e.amount, e.payoutId?.toHexString()])).toEqual([
      ['withdraw-all', 1_000, r.payoutId],
      ['withdraw-all', 2_500, r.payoutId],
    ]);
    expect(await SusuPayoutModel.findById(r.payoutId)).toMatchObject({
      amount: 6_500,
      commissionAmount: 3_500,
    });
    expect(await susu.susuBalanceAsOf(accountId, new Date())).toBe(0);
  });

  it('a customer who has only paid in is left alone', async () => {
    const { accountId } = await accountWith(1_000, 1);
    const a = await susu.getAccount(officer, accountId);
    expect(a).toMatchObject({ balance: 1_000, locked: 1_000 });
    expect(await CommissionModel.countDocuments({ accountId })).toBe(0);
  });

  it('GHS 10/day, 5 paid: GHS 10 to Yadah, GHS 40 cash, the cycle ends, the plan runs on', async () => {
    const { accountId, planId } = await accountWith(1_000, 5);
    const r = await susu.withdrawAll(officer, accountId, randomUUID());

    expect(r.amount).toBe(4_000);
    expect(r.commission).toBe(1_000);
    expect(r.account).toMatchObject({ status: 'active', balance: 0, locked: 0 });
    expect(r.account.plans[0]).toMatchObject({
      status: 'active',
      paidInCycle: 0,
      cycleNumber: 2,
      // Ended early, not completed.
      cyclesCompleted: 0,
      balance: 0,
    });

    const entry = await CommissionModel.findOne({ accountId });
    expect(entry).toMatchObject({ amount: 1_000, reason: 'withdraw-all', cycleNumber: 1 });
    expect(entry?.payoutId?.toHexString()).toBe(r.payoutId);
    const payout = await SusuPayoutModel.findById(r.payoutId);
    expect(payout).toMatchObject({ kind: 'withdrawal', amount: 4_000, commissionAmount: 1_000 });
    expect(await SusuCycleModel.findOne({ planId })).toMatchObject({
      endReason: 'withdraw-all',
      payments: 5,
      commissionAmount: 1_000,
    });
    // The receipt's rebuilt balance agrees with the account.
    expect(await susu.susuBalanceAsOf(accountId, new Date())).toBe(0);

    // The next deposit opens cycle 2, which completes at 31 like any other.
    const next = await pay(accountId, planId.toHexString(), 1_000, 31);
    expect(next.deposit.lines[0]).toMatchObject({ cycleNumber: 2, seqStart: 1, seqEnd: 31 });
    expect(next.account.plans[0]).toMatchObject({ cyclesCompleted: 1, cycleNumber: 3 });
    expect(next.account.balance).toBe(30_000);
  });

  it('each plan mid-cycle gives one day of its own amount', async () => {
    const { accountId } = await accountWith(1_000, 3);
    const b = await susu.addPlan(officer, accountId, 2_500);
    await pay(accountId, b.plan.id, 2_500, 2);
    // A third plan between cycles gives nothing.
    await susu.addPlan(officer, accountId, 5_000);

    const r = await susu.withdrawAll(officer, accountId, randomUUID());
    expect(r.commission).toBe(1_000 + 2_500);
    expect(r.amount).toBe(3_000 + 5_000 - 3_500);
    expect(await SusuAccountModel.findById(accountId)).toMatchObject({ balance: 0 });
  });

  it('only commission left: all of it to Yadah, nothing handed over; an empty account is refused', async () => {
    const { accountId } = await accountWith(1_000, 1);
    const only = await susu.withdrawAll(officer, accountId, randomUUID());
    expect(only).toMatchObject({ amount: 0, commission: 1_000 });
    expect(only.account).toMatchObject({ balance: 0, locked: 0 });
    await expect(susu.withdrawAll(officer, accountId, randomUUID())).rejects.toMatchObject({
      code: 'NOTHING_TO_WITHDRAW',
      status: 422,
    });
  });

  it('replays under the same key', async () => {
    const other = await accountWith(1_000, 6);
    const key = randomUUID();
    const first = await susu.withdrawAll(officer, other.accountId, key);
    const again = await susu.withdrawAll(officer, other.accountId, key);
    expect(again.replayed).toBe(true);
    expect(again.payoutId).toBe(first.payoutId);
    expect(again.commission).toBe(1_000);
    expect(await CommissionModel.countDocuments({ accountId: other.accountId })).toBe(1);
  });

  it('a deposit inside a cycle that withdraw-all ended cannot be trashed', async () => {
    const { accountId } = await accountWith(1_000, 2);
    const last = await susu.recordDeposit(officer, accountId, 1_000, randomUUID(), 'cash');
    await susu.withdrawAll(officer, accountId, randomUUID());
    await expect(
      susu.trashDeposit(officer, accountId, oid(last.deposit.id), 'oops'),
    ).rejects.toMatchObject({ code: 'CANNOT_TRASH' });
    const plan = await SusuPlanModel.findOne({ accountId });
    expect(plan).toMatchObject({ paidInCycle: 0, cyclesCompleted: 1, cyclesEndedEarly: 1 });
  });
});
