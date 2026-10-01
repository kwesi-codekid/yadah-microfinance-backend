import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import {
  AuditLogModel,
  CustomerModel,
  SusuAccountModel,
  SusuCycleModel,
  SusuDepositModel,
  SusuPayoutModel,
  SusuPlanModel,
} from '../../src/models/index.js';
import { backfillPayoutLines, migrateSusuPlans } from '../../src/scripts/migrate-susu-plans.js';
import { runSusuMigration } from '../../src/modules/susu/susu.migration.js';
import * as susu from '../../src/modules/susu/susu.service.js';
import { asOfficer, makeCustomer, setupDb, teardownDb } from './helpers.js';

beforeAll(async () => {
  await setupDb();
  // The database being migrated predates the one-account-per-customer rule,
  // so it carries no such index; the migration builds it at the end.
  for (const name of ['customerId_1', 'accountNumber_1']) {
    await SusuAccountModel.collection.dropIndex(name).catch(() => undefined);
  }
});
afterAll(teardownDb);

const officer = asOfficer();
const staff = new Types.ObjectId();
const oid = (id: string): Types.ObjectId => new Types.ObjectId(id);
const day = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

/** An old-shape book, written raw — the model no longer has these fields. */
async function oldBook(
  customerId: Types.ObjectId,
  input: {
    number: string;
    daily: number;
    deposits: number;
    withdrawn?: number;
    status: 'active' | 'completed' | 'pending-payout' | 'closed' | 'terminated';
    commission?: number;
    payoutRemaining?: number;
    openedDaysAgo: number;
  },
): Promise<Types.ObjectId> {
  const id = new Types.ObjectId();
  await SusuAccountModel.collection.insertOne({
    _id: id,
    accountNumber: input.number,
    customerId,
    dailyAmount: input.daily,
    depositsCount: input.deposits,
    totalDeposited: input.daily * input.deposits,
    withdrawnAmount: input.withdrawn ?? 0,
    status: input.status,
    openedById: staff,
    ...(input.commission !== undefined ? { commissionAmount: input.commission } : {}),
    payoutRemaining: input.payoutRemaining ?? 0,
    ...(input.status === 'closed' ||
    input.status === 'terminated' ||
    input.status === 'pending-payout'
      ? { closedAt: day(1), closedById: staff }
      : {}),
    deletedAt: null,
    createdAt: day(input.openedDaysAgo),
    updatedAt: day(input.openedDaysAgo),
  });
  // One deposit per day paid, oldest first.
  for (let i = 0; i < input.deposits; i += 1) {
    await SusuDepositModel.collection.insertOne({
      accountId: id,
      customerId,
      collectorId: staff,
      amount: input.daily,
      daysCovered: 1,
      seqStart: i + 1,
      seqEnd: i + 1,
      channel: 'cash',
      idempotencyKey: randomUUID(),
      deletedAt: null,
      createdAt: day(input.openedDaysAgo - i),
      updatedAt: day(input.openedDaysAgo - i),
    });
  }
  if ((input.withdrawn ?? 0) > 0) {
    await SusuPayoutModel.collection.insertOne({
      accountId: id,
      customerId,
      amount: input.withdrawn,
      kind: 'partial-withdrawal',
      destination: 'cash',
      commissionAmount: 0,
      recordedById: staff,
      createdAt: day(1),
      updatedAt: day(1),
    });
  }
  // A closed book was paid out: what it held, less its commission.
  if (input.status === 'closed' || input.status === 'terminated') {
    await SusuPayoutModel.collection.insertOne({
      accountId: id,
      customerId,
      amount: input.daily * input.deposits - (input.withdrawn ?? 0) - (input.commission ?? 0),
      kind: 'payout',
      destination: 'cash',
      commissionAmount: input.commission ?? 0,
      recordedById: staff,
      createdAt: day(1),
      updatedAt: day(1),
    });
  }
  return id;
}

describe('migrating per-cycle books into one account with plans', () => {
  it('merges a customer’s books, keeps the counts, and reconciles the money', async () => {
    const customerId = await makeCustomer();
    await CustomerModel.updateOne({ _id: customerId }, { $set: { susuNumber: 'SU26090009' } });
    // Their September book, active at 12 of 31 with GHS 30 already withdrawn.
    await oldBook(customerId, {
      number: 'SU26090009-SEP',
      daily: 1_000,
      deposits: 12,
      withdrawn: 3_000,
      status: 'active',
      openedDaysAgo: 40,
    });
    // A second book, completed and waiting to be closed.
    await oldBook(customerId, {
      number: 'SU26090009-SEP',
      daily: 2_000,
      deposits: 31,
      status: 'completed',
      openedDaysAgo: 35,
    });
    // An older, closed book: commission taken, paid out.
    await oldBook(customerId, {
      number: 'SU26090009-AUG',
      daily: 500,
      deposits: 31,
      status: 'closed',
      commission: 500,
      openedDaysAgo: 80,
    });

    const summary = await migrateSusuPlans(true);
    expect(summary.customers).toBe(1);
    expect(summary.books).toBe(3);
    // 9,000 held on the first + 62,000 on the completed; the completed book's
    // commission (2,000) is taken now, under the new rule.
    expect(summary.balanceBefore).toBe(9_000 + 62_000);
    expect(summary.commissionTakenNow).toBe(2_000);
    expect(summary.balanceAfter).toBe(9_000 + 60_000);

    // The oldest book is the one kept — here the closed August one.
    const kept = await SusuAccountModel.findOne({ customerId });
    if (!kept) throw new Error('no account survived');
    const first = kept._id;
    const account = await susu.getAccount(officer, first);
    expect(account.accountNumber).toBe('SU26090009');
    expect(account.status).toBe('active');
    expect(account.balance).toBe(69_000);
    expect(
      account.plans.map((p) => [p.dailyAmount, p.status, p.paidInCycle, p.cyclesCompleted]),
    ).toEqual([
      [1_000, 'active', 12, 0],
      [2_000, 'active', 0, 1],
      [500, 'stopped', 0, 1],
    ]);
    // Only the plan mid-cycle locks anything.
    expect(account.locked).toBe(1_000);
    expect(await SusuAccountModel.countDocuments({ customerId })).toBe(1);

    // Deposits moved over in the new shape, still 12 + 31 + 31 of them.
    const deposits = await SusuDepositModel.find({ accountId: first });
    expect(deposits).toHaveLength(74);
    expect(deposits.every((d) => d.lines.length === 1 && d.lines[0]?.payments === 1)).toBe(true);
    // The 31st payment of the completed book carries the commission taken now.
    const thirtyFirst = deposits.filter(
      (d) => d.lines[0]?.seqEnd === 31 && d.lines[0].dailyAmount === 2_000,
    );
    expect(thirtyFirst).toHaveLength(1);
    expect(thirtyFirst[0]?.commissionAmount).toBe(2_000);

    // The withdrawal came over as a withdrawal, and each book's payouts became
    // that book's plan's lines — so the plans' balances add up to the account's.
    const payouts = await SusuPayoutModel.find({ accountId: first }).sort({ amount: 1 });
    expect(payouts.map((p) => [p.kind, p.amount, p.lines?.length])).toEqual([
      ['withdrawal', 3_000, 1],
      ['payout', 15_000, 1],
    ]);
    const tenPlan = account.plans.find((p) => p.dailyAmount === 1_000);
    const fivePlan = account.plans.find((p) => p.dailyAmount === 500);
    expect(payouts[0]?.lines?.[0]).toMatchObject({ planId: oid(tenPlan!.id), paymentsRemoved: 0 });
    expect(payouts[1]?.lines?.[0]).toMatchObject({ planId: oid(fivePlan!.id), paymentsRemoved: 0 });
    expect(account.plans.map((p) => [p.dailyAmount, p.balance, p.withdrawn])).toEqual([
      [1_000, 9_000, 3_000],
      [2_000, 60_000, 0],
      [500, 0, 15_000],
    ]);
    expect(summary.payoutsLabelled).toBe(2);
    const cycles = await SusuCycleModel.find({ accountId: first }).sort({ dailyAmount: 1 });
    expect(cycles.map((c) => [c.dailyAmount, c.endReason, c.commissionAmount])).toEqual([
      [500, 'completed', 500],
      [2_000, 'completed', 2_000],
    ]);

    // And the account works: a deposit lands on both running plans.
    const r = await susu.recordDeposit(officer, first, 3_000, randomUUID(), 'cash');
    expect(r.account.plans.map((p) => p.paidInCycle)).toEqual([13, 1, 0]);
    expect(r.account.balance).toBe(72_000);
  });

  it('closes a customer whose every book had been paid out, and leaves migrated accounts alone', async () => {
    const customerId = await makeCustomer();
    const id = await oldBook(customerId, {
      number: '482913-JUL',
      daily: 1_000,
      deposits: 10,
      status: 'terminated',
      commission: 0,
      openedDaysAgo: 60,
    });
    const before = await migrateSusuPlans(true);
    const account = await SusuAccountModel.findById(id);
    expect(account).toMatchObject({ accountNumber: '482913', status: 'closed', balance: 0 });
    expect((await SusuPlanModel.findOne({ accountId: id }))?.status).toBe('stopped');

    // Running it again finds nothing left to do.
    const again = await migrateSusuPlans(true);
    expect(again.books).toBe(0);
    expect(before.books).toBeGreaterThan(0);
    expect(await SusuPlanModel.countDocuments({ accountId: id })).toBe(1);
  });

  it('gives a migrated account’s unlabelled withdrawals their plan shares, walking the plans', async () => {
    // An account already in the new shape: GHS 10 a day at 10 of 31, then a
    // GHS 20 plan at 3 of 31. Two withdrawals were made before withdrawals
    // recorded their shares — written raw, as they would sit in the database.
    const customerId = await makeCustomer();
    const { account } = await susu.openAccount(officer, customerId, 1_000);
    const accountId = oid(account.id);
    const a = account.plans[0]!.id;
    await susu.recordDeposit(
      officer,
      accountId,
      10_000,
      randomUUID(),
      'cash',
      undefined,
      undefined,
      [{ planId: a, payments: 10 }],
    );
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
    for (const [amount, daysAgo] of [
      [9_500, 2],
      [2_000, 1],
    ] as const) {
      await SusuPayoutModel.collection.insertOne({
        accountId,
        customerId,
        amount,
        kind: 'withdrawal',
        destination: 'cash',
        commissionAmount: 0,
        recordedById: staff,
        createdAt: day(daysAgo),
        updatedAt: day(daysAgo),
      });
    }
    await SusuAccountModel.updateOne({ _id: accountId }, { $inc: { balance: -11_500 } });

    // Before: the plans still claim everything they were paid.
    const before = await susu.getAccount(officer, accountId);
    expect(before.plans.map((p) => p.balance)).toEqual([10_000, 6_000]);

    const dry = await backfillPayoutLines(false);
    expect(dry).toMatchObject({ accounts: 1, payouts: 2, loose: 0 });
    expect(await SusuPayoutModel.countDocuments({ accountId, lines: { $exists: true } })).toBe(0);

    const summary = await backfillPayoutLines(true);
    expect(summary).toMatchObject({ accounts: 1, payouts: 2, loose: 0 });
    const payouts = await SusuPayoutModel.find({ accountId }).sort({ createdAt: 1 });
    // The first walks A (100 less its 10 lock = 90) then B for the last 5;
    // the second finds A holding only its lock and comes off B. No days cost.
    expect(
      payouts[0]?.lines?.map((l) => [l.planId.toHexString(), l.amount, l.paymentsRemoved]),
    ).toEqual([
      [a, 9_000, 0],
      [second.id, 500, 0],
    ]);
    expect(
      payouts[1]?.lines?.map((l) => [l.planId.toHexString(), l.amount, l.paymentsRemoved]),
    ).toEqual([[second.id, 2_000, 0]]);

    // After: the plans add up to the account, and the cycles never moved.
    const after = await susu.getAccount(officer, accountId);
    expect(after.plans.map((p) => [p.balance, p.withdrawn, p.paidInCycle])).toEqual([
      [1_000, 9_000, 10],
      [3_500, 2_500, 3],
    ]);
    expect(after.balance).toBe(4_500);

    // Running it again finds nothing left to do.
    expect(await backfillPayoutLines(true)).toEqual({ accounts: 0, payouts: 0, loose: 0 });
  });

  it('runs from the office screen: a dry run writes nothing, an apply writes and is audited', async () => {
    const customerId = await makeCustomer();
    const { account } = await susu.openAccount(officer, customerId, 1_000);
    const accountId = oid(account.id);
    await susu.recordDeposit(
      officer,
      accountId,
      5_000,
      randomUUID(),
      'cash',
      undefined,
      undefined,
      [{ planId: account.plans[0]!.id, payments: 5 }],
    );
    await SusuPayoutModel.collection.insertOne({
      accountId,
      customerId,
      amount: 2_000,
      kind: 'withdrawal',
      destination: 'cash',
      commissionAmount: 0,
      recordedById: staff,
      createdAt: day(1),
      updatedAt: day(1),
    });

    const audits = await AuditLogModel.countDocuments({ action: 'susu.migrate' });
    const dry = await runSusuMigration(officer, false);
    expect(dry.apply).toBe(false);
    expect(dry.backfill.payouts).toBe(1);
    expect(dry.drift).toBe(0);
    expect(await SusuPayoutModel.countDocuments({ accountId, lines: { $exists: true } })).toBe(0);
    expect(await AuditLogModel.countDocuments({ action: 'susu.migrate' })).toBe(audits);

    const applied = await runSusuMigration(officer, true);
    expect(applied.apply).toBe(true);
    expect(applied.backfill.payouts).toBe(1);
    expect(await SusuPayoutModel.countDocuments({ accountId, lines: { $exists: true } })).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'susu.migrate' })).toBe(audits + 1);
  });
});
