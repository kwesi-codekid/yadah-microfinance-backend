import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import {
  CustomerModel,
  AuditLogModel,
  SusuAccountModel,
  SusuCycleModel,
  SusuDepositModel,
  SusuPayoutModel,
} from '../../src/models/index.js';
import { accountPeriodKey } from '../../src/lib/account-number.js';
import { renumberThisMonth } from '../../src/modules/susu/susu.renumber.js';
import * as susu from '../../src/modules/susu/susu.service.js';
import { asOfficer, makeCustomer, setupDb, teardownDb } from './helpers.js';

beforeAll(setupDb);
afterAll(teardownDb);

const officer = asOfficer();
const oid = (id: string): Types.ObjectId => new Types.ObjectId(id);

/** One account with one plan, and `payments` paid into it. */
async function accountWith(daily: number, payments = 0) {
  const customerId = await makeCustomer();
  const { account } = await susu.openAccount(officer, customerId, daily);
  const accountId = oid(account.id);
  const planId = oid(account.plans[0]!.id);
  if (payments > 0) {
    await susu.recordDeposit(
      officer,
      accountId,
      daily * payments,
      randomUUID(),
      'cash',
      undefined,
      undefined,
      [{ planId: planId.toHexString(), payments }],
    );
  }
  return { customerId, accountId, planId };
}

/**
 * One susu account per customer, like savings, with plans running their own
 * 31-payment cycles inside it (client decision, 30 Sep 2026).
 */
describe('the one account', () => {
  it('opens once per customer, with its first plan', async () => {
    const customerId = await makeCustomer();
    const opened = await susu.openAccount(officer, customerId, 1_000);
    expect(opened.reopened).toBe(false);
    expect(opened.account).toMatchObject({ status: 'active', balance: 0, dailyTotal: 1_000 });
    expect(opened.account.plans).toHaveLength(1);
    expect(opened.account.plans[0]).toMatchObject({
      dailyAmount: 1_000,
      paidInCycle: 0,
      cycleNumber: 1,
      status: 'active',
      amountChangeable: true,
    });

    // A second opening is refused with the account to use.
    await expect(susu.openAccount(officer, customerId, 2_000)).rejects.toMatchObject({
      code: 'ALREADY_OPEN',
      status: 409,
      details: { accountId: opened.account.id },
    });
    expect(await SusuAccountModel.countDocuments({ customerId })).toBe(1);
  });

  it('reopens a closed account with the same number and history', async () => {
    const { customerId, accountId } = await accountWith(1_000, 3);
    const closed = await susu.closeAccount(officer, accountId);
    expect(closed.account.status).toBe('closed');

    const reopened = await susu.openAccount(officer, customerId, 2_000);
    expect(reopened.reopened).toBe(true);
    expect(reopened.account.id).toBe(accountId.toHexString());
    expect(reopened.account.accountNumber).toBe(closed.account.accountNumber);
    expect(reopened.account.status).toBe('active');
    expect(reopened.account.balance).toBe(0);
    // The old plan stays as history; the new one is what runs.
    expect(reopened.account.plans.map((p) => [p.dailyAmount, p.status])).toEqual([
      [2_000, 'active'],
      [1_000, 'stopped'],
    ]);
  });
});

describe('deposits credit the plans and the balance', () => {
  it('a default deposit is one payment on every active plan', async () => {
    const { accountId } = await accountWith(1_000);
    await susu.addPlan(officer, accountId, 2_000);

    const r = await susu.recordDeposit(officer, accountId, 3_000, randomUUID(), 'cash');
    expect(r.deposit.payments).toBe(2);
    expect(r.deposit.lines.map((l) => [l.dailyAmount, l.seqStart, l.seqEnd])).toEqual([
      [1_000, 1, 1],
      [2_000, 1, 1],
    ]);
    expect(r.deposit.leftover).toBe(0);
    expect(r.account.balance).toBe(3_000);
    expect(r.account.plans.map((p) => p.paidInCycle)).toEqual([1, 1]);
  });

  it('counts by amount: five times the daily amount is 5 of 31', async () => {
    const { accountId } = await accountWith(1_000);
    const r = await susu.recordDeposit(
      officer,
      accountId,
      5_000,
      randomUUID(),
      'cash',
      undefined,
      undefined,
      [{ planId: r0(await susu.getAccount(officer, accountId)), payments: 5 }],
    );
    expect(r.deposit.lines[0]).toMatchObject({ payments: 5, seqStart: 1, seqEnd: 5 });
    expect(r.account.plans[0]?.paidInCycle).toBe(5);
    expect(r.account.balance).toBe(5_000);
  });

  it('staff choose the split, and what does not make a whole payment stays in the balance', async () => {
    const { accountId } = await accountWith(1_000);
    const { plan } = await susu.addPlan(officer, accountId, 2_000);
    const a = await susu.getAccount(officer, accountId);
    const planA = a.plans.find((p) => p.dailyAmount === 1_000)!.id;

    // GHS 55: three payments on the 10 plan, one on the 20 plan, GHS 5 over.
    const r = await susu.recordDeposit(
      officer,
      accountId,
      5_500,
      randomUUID(),
      'cash',
      undefined,
      undefined,
      [
        { planId: planA, payments: 3 },
        { planId: plan.id, payments: 1 },
      ],
    );
    expect(r.deposit.leftover).toBe(500);
    expect(r.account.balance).toBe(5_500);
    expect(r.account.plans.map((p) => [p.dailyAmount, p.paidInCycle])).toEqual([
      [1_000, 3],
      [2_000, 1],
    ]);
  });

  it('refuses a split the cash cannot cover, and a deposit that pays no plan', async () => {
    const { accountId, planId } = await accountWith(1_000);
    await expect(
      susu.recordDeposit(officer, accountId, 500, randomUUID(), 'cash'),
    ).rejects.toMatchObject({ code: 'INVALID_SPLIT', status: 422 });
    await expect(
      susu.recordDeposit(officer, accountId, 5_000, randomUUID(), 'cash', undefined, undefined, [
        { planId: planId.toHexString(), payments: 0 },
      ]),
    ).rejects.toMatchObject({ code: 'INVALID_SPLIT' });
    expect(await SusuDepositModel.countDocuments({ accountId })).toBe(0);
  });

  it('the 31st payment completes the cycle and takes one payment as commission', async () => {
    const { accountId, planId } = await accountWith(1_000, 30);
    const r = await susu.recordDeposit(officer, accountId, 1_000, randomUUID(), 'cash');

    expect(r.deposit.lines[0]).toMatchObject({
      seqEnd: 31,
      completesCycle: true,
      commissionAmount: 1_000,
    });
    expect(r.deposit.commissionAmount).toBe(1_000);
    // 31,000 paid in, 1,000 kept as commission.
    expect(r.account.balance).toBe(30_000);
    expect(r.account.plans[0]).toMatchObject({
      paidInCycle: 0,
      cyclesCompleted: 1,
      cycleNumber: 2,
      locked: 0,
      amountChangeable: true,
    });
    const cycle = await SusuCycleModel.findOne({ planId });
    expect(cycle).toMatchObject({
      cycleNumber: 1,
      payments: 31,
      commissionAmount: 1_000,
      endReason: 'completed',
    });
  });

  it('overflow past 31 starts the next cycle at the same amount', async () => {
    const { accountId, planId } = await accountWith(1_000, 29);
    const r = await susu.recordDeposit(
      officer,
      accountId,
      5_000,
      randomUUID(),
      'cash',
      undefined,
      undefined,
      [{ planId: planId.toHexString(), payments: 5 }],
    );
    expect(r.deposit.lines.map((l) => [l.cycleNumber, l.seqStart, l.seqEnd])).toEqual([
      [1, 30, 31],
      [2, 1, 3],
    ]);
    expect(r.deposit.commissionAmount).toBe(1_000);
    expect(r.account.plans[0]).toMatchObject({ paidInCycle: 3, cyclesCompleted: 1 });
    expect(r.account.balance).toBe(29_000 + 5_000 - 1_000);
  });

  it('refuses one deposit that would run a plan through three cycles', async () => {
    const { accountId, planId } = await accountWith(1_000);
    await expect(
      susu.recordDeposit(officer, accountId, 63_000, randomUUID(), 'cash', undefined, undefined, [
        { planId: planId.toHexString(), payments: 63 },
      ]),
    ).rejects.toMatchObject({ code: 'INVALID_SPLIT' });
  });

  it('replays under the same idempotency key without writing again', async () => {
    const { accountId } = await accountWith(1_000);
    const key = randomUUID();
    const first = await susu.recordDeposit(officer, accountId, 2_000, key, 'cash');
    const second = await susu.recordDeposit(officer, accountId, 2_000, key, 'cash');
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.deposit.id).toBe(first.deposit.id);
    expect((await SusuAccountModel.findById(accountId))?.balance).toBe(2_000);
  });

  it('concurrent deposits never lose updates', async () => {
    const { accountId } = await accountWith(1_000);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        susu.recordDeposit(officer, accountId, 1_000, randomUUID(), 'cash'),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const after = await susu.getAccount(officer, accountId);
    expect(after.plans[0]?.paidInCycle).toBe(ok);
    expect(after.balance).toBe(ok * 1_000);
    expect(await SusuDepositModel.countDocuments({ accountId })).toBe(ok);
  });
});

describe('the lock and withdrawals', () => {
  it('locks one payment per plan with a cycle in progress', async () => {
    const { accountId } = await accountWith(1_000, 10);
    await susu.addPlan(officer, accountId, 2_000);
    // The new plan is between cycles: nothing locked for it yet.
    let a = await susu.getAccount(officer, accountId);
    expect(a.locked).toBe(1_000);
    expect(a.availableToWithdraw).toBe(9_000);

    await susu.recordDeposit(officer, accountId, 3_000, randomUUID(), 'cash');
    a = await susu.getAccount(officer, accountId);
    expect(a.balance).toBe(13_000);
    expect(a.locked).toBe(3_000);
    expect(a.availableToWithdraw).toBe(10_000);
  });

  it('takes money, takes the days off the plan, and stops at the lock', async () => {
    const { accountId } = await accountWith(1_000, 10);
    const r = await susu.withdraw(officer, accountId, 4_000, randomUUID());
    expect(r.amount).toBe(4_000);
    expect(r.account.balance).toBe(6_000);
    // Four payments' worth out, four days off (user decision, 30 Sep 2026).
    expect(r.account.plans[0]?.paidInCycle).toBe(6);

    await expect(susu.withdraw(officer, accountId, 5_001, randomUUID())).rejects.toMatchObject({
      code: 'EXCEEDS_AVAILABLE',
      status: 422,
      details: { available: 5_000, locked: 1_000 },
    });
    const ok = await susu.withdraw(officer, accountId, 5_000, randomUUID());
    expect(ok.account.balance).toBe(1_000);
    expect(ok.account.availableToWithdraw).toBe(0);
    // The last payment stays in, locked, and stays on the card.
    expect(ok.account.plans[0]?.paidInCycle).toBe(1);

    const rows = await SusuPayoutModel.find({ accountId });
    expect(rows).toHaveLength(2);
    expect(rows.every((p) => p.kind === 'withdrawal' && p.commissionAmount === 0)).toBe(true);
  });

  it('the whole balance is withdrawable when no cycle is in progress', async () => {
    const { accountId } = await accountWith(1_000, 31);
    const a = await susu.getAccount(officer, accountId);
    expect(a.balance).toBe(30_000);
    expect(a.locked).toBe(0);
    const r = await susu.withdraw(officer, accountId, 30_000, randomUUID());
    expect(r.account.balance).toBe(0);
  });

  it('replays a withdrawal under the same key', async () => {
    const { accountId } = await accountWith(1_000, 10);
    const key = randomUUID();
    await susu.withdraw(officer, accountId, 1_000, key);
    const again = await susu.withdraw(officer, accountId, 1_000, key);
    expect(again.replayed).toBe(true);
    expect((await SusuAccountModel.findById(accountId))?.balance).toBe(9_000);
  });

  it('the money walks the plans, each recording its share and losing its days', async () => {
    // Plan A: GHS 10 a day, 10 of 31, holds GHS 100. Plan B: GHS 20 a day,
    // 3 of 31, holds GHS 60. Balance GHS 160, lock GHS 30.
    const { accountId, planId } = await accountWith(1_000, 10);
    const { plan: second } = await susu.addPlan(officer, accountId, 2_000);
    await susu.recordDeposit(
      officer,
      accountId,
      6_000,
      randomUUID(),
      'cash',
      undefined,
      undefined,
      [{ planId: second.id, payments: 3 }],
    );
    const a = planId.toHexString();
    const b = second.id;

    const before = await susu.getAccount(officer, accountId);
    expect(before.plans.map((p) => [p.id, p.balance, p.withdrawn])).toEqual([
      [a, 10_000, 0],
      [b, 6_000, 0],
    ]);

    // GHS 15: all off A — one payment and GHS 5 that costs no day.
    const small = await susu.withdraw(officer, accountId, 1_500, randomUUID());
    expect(small.lines).toEqual([
      { planId: a, dailyAmount: 1_000, amount: 1_500, paymentsRemoved: 1 },
    ]);
    expect(small.loose).toBe(0);
    expect(small.account.plans.find((p) => p.id === a)).toMatchObject({
      paidInCycle: 9,
      balance: 8_500,
      withdrawn: 1_500,
    });

    // GHS 100: A gives what it holds less its lock (85 − 10 = 75, 7 payments,
    // GHS 5 costing no day); the other 25 comes off B (one payment).
    const walk = await susu.withdraw(officer, accountId, 10_000, randomUUID());
    expect(walk.lines).toEqual([
      { planId: a, dailyAmount: 1_000, amount: 7_500, paymentsRemoved: 7 },
      { planId: b, dailyAmount: 2_000, amount: 2_500, paymentsRemoved: 1 },
    ]);
    expect(walk.loose).toBe(0);
    const after = walk.account;
    expect(after.balance).toBe(16_000 - 11_500);
    expect(after.plans.find((p) => p.id === a)).toMatchObject({
      paidInCycle: 2,
      balance: 1_000,
      withdrawn: 9_000,
    });
    expect(after.plans.find((p) => p.id === b)).toMatchObject({
      paidInCycle: 2,
      balance: 3_500,
      withdrawn: 2_500,
    });

    // Completed cycles are never entered, and the lock still holds the last
    // payment of each cycle in progress: what is left is exactly the locks.
    expect(after.locked).toBe(3_000);
    expect(after.availableToWithdraw).toBe(1_500);

    const rows = await SusuPayoutModel.find({ accountId }).sort({ createdAt: 1 });
    expect(rows.map((p) => p.lines?.length)).toEqual([1, 2]);
    expect(rows[1]?.lines?.map((l) => l.planId.toHexString())).toEqual([a, b]);

    // The statement's other half: money out, newest first, narrowable to a plan.
    const all = await susu.listAccountPayouts(officer, accountId, { page: 1, limit: 10 });
    expect(all.total).toBe(2);
    expect(all.items[0]?.lines?.map((l) => l.planId)).toEqual([a, b]);
    const onlyB = await susu.listAccountPayouts(officer, accountId, {
      page: 1,
      limit: 10,
      planId: oid(b),
    });
    expect(onlyB.items.map((p) => p.amount)).toEqual([10_000]);
  });
});

describe('plans', () => {
  it('a second amount starts its own cycle', async () => {
    const { accountId } = await accountWith(1_000, 12);
    const { account, plan } = await susu.addPlan(officer, accountId, 2_000);
    expect(account.plans).toHaveLength(2);
    expect(plan).toMatchObject({ dailyAmount: 2_000, paidInCycle: 0, cycleNumber: 1 });
    expect(account.dailyTotal).toBe(3_000);
    expect(account.plans[0]?.paidInCycle).toBe(12); // the first is where it was
  });

  it('the amount changes only between cycles', async () => {
    const { accountId, planId } = await accountWith(1_000, 5);
    await expect(susu.changePlanAmount(officer, accountId, planId, 1_500)).rejects.toMatchObject({
      code: 'PLAN_MID_CYCLE',
      status: 422,
    });

    // Finish the cycle, then change it: the next cycle runs at the new amount.
    await susu.recordDeposit(
      officer,
      accountId,
      26_000,
      randomUUID(),
      'cash',
      undefined,
      undefined,
      [{ planId: planId.toHexString(), payments: 26 }],
    );
    const changed = await susu.changePlanAmount(officer, accountId, planId, 1_500);
    expect(changed.plan).toMatchObject({ dailyAmount: 1_500, paidInCycle: 0, cycleNumber: 2 });

    const r = await susu.recordDeposit(officer, accountId, 1_500, randomUUID(), 'cash');
    expect(r.deposit.lines[0]).toMatchObject({ dailyAmount: 1_500, cycleNumber: 2, seqEnd: 1 });
    expect(r.account.locked).toBe(1_500);
  });

  it('stopping mid-cycle charges one payment and records the cut-short cycle', async () => {
    const { accountId, planId } = await accountWith(1_000, 10);
    const r = await susu.stopPlan(officer, accountId, planId);
    expect(r.commission).toBe(1_000);
    expect(r.plan).toMatchObject({ status: 'stopped', stopCommission: 1_000, locked: 0 });
    expect(r.account.balance).toBe(9_000);
    expect(r.account.locked).toBe(0);
    expect(r.account.dailyTotal).toBe(0);
    expect(await SusuCycleModel.findOne({ planId })).toMatchObject({
      cycleNumber: 1,
      payments: 10,
      commissionAmount: 1_000,
      endReason: 'plan-stopped',
    });
    await expect(
      susu.recordDeposit(officer, accountId, 1_000, randomUUID(), 'cash'),
    ).rejects.toMatchObject({ code: 'NO_ACTIVE_PLANS' });
  });

  it('stopping between cycles charges nothing', async () => {
    const { accountId, planId } = await accountWith(1_000, 31);
    const r = await susu.stopPlan(officer, accountId, planId);
    expect(r.commission).toBe(0);
    expect(r.account.balance).toBe(30_000);
    expect(await SusuCycleModel.countDocuments({ planId })).toBe(1); // the completed one only
  });
});

describe('closing the account', () => {
  it('charges every plan mid-cycle once and pays out the rest', async () => {
    const { accountId } = await accountWith(1_000, 10);
    await susu.addPlan(officer, accountId, 2_000);
    await susu.recordDeposit(officer, accountId, 3_000, randomUUID(), 'cash'); // 13,000 held
    const r = await susu.closeAccount(officer, accountId);
    expect(r.commission).toBe(3_000);
    expect(r.payout).toBe(10_000);
    expect(r.account).toMatchObject({ status: 'closed', balance: 0, closeCommission: 3_000 });
    expect(r.account.plans.every((p) => p.status === 'stopped')).toBe(true);

    const payout = await SusuPayoutModel.findOne({ accountId, kind: 'payout' });
    expect(payout).toMatchObject({ amount: 10_000, commissionAmount: 3_000, destination: 'cash' });
    expect(await SusuCycleModel.countDocuments({ accountId, endReason: 'account-closed' })).toBe(2);
  });

  it('still records the closure when nothing is left to hand over', async () => {
    const { accountId } = await accountWith(1_000, 5);
    await susu.withdraw(officer, accountId, 4_000, randomUUID());
    const r = await susu.closeAccount(officer, accountId);
    expect(r.payout).toBe(0);
    expect(r.commission).toBe(1_000);
    expect(await SusuPayoutModel.countDocuments({ accountId, kind: 'payout' })).toBe(1);
  });

  it('is refused twice, and nothing may be recorded on a closed account', async () => {
    const { accountId } = await accountWith(1_000, 1);
    await susu.closeAccount(officer, accountId);
    await expect(susu.closeAccount(officer, accountId)).rejects.toMatchObject({
      code: 'ALREADY_CLOSED',
    });
    await expect(
      susu.recordDeposit(officer, accountId, 1_000, randomUUID(), 'cash'),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CLOSED' });
    await expect(susu.withdraw(officer, accountId, 1, randomUUID())).rejects.toMatchObject({
      code: 'ACCOUNT_CLOSED',
    });
  });
});

describe('correcting deposits', () => {
  it('trashing the latest deposit un-credits the plan, undoes a completed cycle, and restoring redoes it', async () => {
    const { accountId, planId } = await accountWith(1_000, 30);
    const last = await susu.recordDeposit(officer, accountId, 1_000, randomUUID(), 'cash');
    expect(last.account.plans[0]?.cyclesCompleted).toBe(1);
    const depositId = oid(last.deposit.id);

    const trashed = await susu.trashDeposit(officer, accountId, depositId, 'entry error');
    expect(trashed.account.plans[0]).toMatchObject({ paidInCycle: 30, cyclesCompleted: 0 });
    // The commission that deposit took goes back with it.
    expect(trashed.account.balance).toBe(30_000);
    expect(await SusuCycleModel.countDocuments({ planId })).toBe(0);

    const restored = await susu.restoreDeposit(officer, accountId, depositId);
    expect(restored.account.plans[0]).toMatchObject({ paidInCycle: 0, cyclesCompleted: 1 });
    expect(restored.account.balance).toBe(30_000);
    expect(await SusuCycleModel.countDocuments({ planId })).toBe(1);
  });

  it('only the latest deposit on a plan can be changed; replays of trashed keys are refused', async () => {
    const { accountId } = await accountWith(1_000);
    const key = randomUUID();
    const first = await susu.recordDeposit(officer, accountId, 1_000, key, 'cash');
    const second = await susu.recordDeposit(officer, accountId, 1_000, randomUUID(), 'cash');

    await expect(
      susu.trashDeposit(officer, accountId, oid(first.deposit.id), undefined),
    ).rejects.toMatchObject({ code: 'CANNOT_TRASH' });

    await susu.trashDeposit(officer, accountId, oid(second.deposit.id), undefined);
    await susu.trashDeposit(officer, accountId, oid(first.deposit.id), undefined);
    await expect(susu.recordDeposit(officer, accountId, 1_000, key, 'cash')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('refuses to take back money that has since been withdrawn', async () => {
    const { accountId } = await accountWith(1_000, 10);
    const last = await susu.recordDeposit(
      officer,
      accountId,
      5_000,
      randomUUID(),
      'cash',
      undefined,
      undefined,
      [{ planId: (await susu.getAccount(officer, accountId)).plans[0]!.id, payments: 5 }],
    );
    await susu.withdraw(officer, accountId, 14_000, randomUUID()); // leaves the 1,000 lock
    await expect(
      susu.trashDeposit(officer, accountId, oid(last.deposit.id), undefined),
    ).rejects.toMatchObject({ code: 'CANNOT_TRASH' });
  });

  it('corrects the latest deposit’s amount, re-crediting from where it started', async () => {
    const { accountId } = await accountWith(1_000, 2);
    const rec = await susu.recordDeposit(
      officer,
      accountId,
      3_000,
      randomUUID(),
      'cash',
      undefined,
      undefined,
      [{ planId: (await susu.getAccount(officer, accountId)).plans[0]!.id, payments: 3 }],
    );
    const depositId = oid(rec.deposit.id);

    // Down to one payment: the plan drops from 5 to 3, the balance follows.
    const down = await susu.updateDeposit(officer, accountId, depositId, 1_000);
    expect(down.deposit).toMatchObject({ amount: 1_000, payments: 1 });
    expect(down.deposit.lines[0]).toMatchObject({ seqStart: 3, seqEnd: 3 });
    expect(down.account.plans[0]?.paidInCycle).toBe(3);
    expect(down.account.balance).toBe(3_000);

    // Up past the cycle's end: the correction completes it and charges the commission.
    const up = await susu.updateDeposit(officer, accountId, depositId, 30_000);
    expect(up.deposit.lines.map((l) => [l.cycleNumber, l.seqStart, l.seqEnd])).toEqual([
      [1, 3, 31],
      [2, 1, 1],
    ]);
    expect(up.deposit.commissionAmount).toBe(1_000);
    expect(up.account.balance).toBe(2_000 + 30_000 - 1_000);
    expect(up.account.plans[0]).toMatchObject({ paidInCycle: 1, cyclesCompleted: 1 });
  });

  it('a deposit split across plans needs the new split spelled out', async () => {
    const { accountId } = await accountWith(1_000);
    await susu.addPlan(officer, accountId, 2_000);
    const rec = await susu.recordDeposit(officer, accountId, 3_000, randomUUID(), 'cash');
    await expect(
      susu.updateDeposit(officer, accountId, oid(rec.deposit.id), 5_000),
    ).rejects.toMatchObject({ code: 'SPLIT_REQUIRED' });
  });
});

describe('the trash', () => {
  it('only an account that never held money can be trashed', async () => {
    const { accountId } = await accountWith(1_000);
    const trashed = await susu.trashSusuAccount(officer, accountId, 'opened in error');
    expect(trashed.deleteReason).toBe('opened in error');
    await susu.restoreSusuAccount(officer, accountId);

    await susu.recordDeposit(officer, accountId, 1_000, randomUUID(), 'cash');
    await expect(susu.trashSusuAccount(officer, accountId, undefined)).rejects.toMatchObject({
      code: 'CANNOT_TRASH',
    });
  });
});

/** The first plan's id on an account. */
function r0(account: susu.PublicSusuAccount): string {
  return account.plans[0]!.id;
}

describe('renumbering this month’s accounts from the office screen (1 Oct 2026)', () => {
  it('carries this month’s numbers on from last month, moving the customer’s number too', async () => {
    const period = accountPeriodKey();
    const last = accountPeriodKey(new Date(Date.now() - 31 * 24 * 60 * 60 * 1000));
    const staff = new Types.ObjectId();
    // Earlier tests opened accounts this month under the live counter; start clean.
    await SusuAccountModel.deleteMany({});
    await CustomerModel.updateMany({}, { $unset: { susuNumber: '' } });
    const older = await makeCustomer();
    const newer = await makeCustomer();
    for (const [customerId, number, daysAgo] of [
      [older, `SU${last}0012`, 35],
      [newer, `SU${period}0001`, 0.02],
    ] as const) {
      await SusuAccountModel.collection.insertOne({
        accountNumber: number,
        customerId,
        balance: 0,
        status: 'active',
        openedById: staff,
        deletedAt: null,
        createdAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      });
      await CustomerModel.updateOne({ _id: customerId }, { $set: { susuNumber: number } });
    }

    const dry = await renumberThisMonth(officer, false);
    expect(dry.changes).toEqual([{ from: `SU${period}0001`, to: `SU${period}0013` }]);
    expect((await CustomerModel.findById(newer))?.susuNumber).toBe(`SU${period}0001`);

    const applied = await renumberThisMonth(officer, true);
    expect(applied.counter).toBe(13);
    expect((await SusuAccountModel.findOne({ customerId: newer }))?.accountNumber).toBe(
      `SU${period}0013`,
    );
    expect((await CustomerModel.findById(newer))?.susuNumber).toBe(`SU${period}0013`);
    expect(await AuditLogModel.countDocuments({ action: 'susu.account.renumber-month' })).toBe(1);
  });
});
