import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { ReconciliationModel } from '../../src/models/index.js';
import * as recon from '../../src/modules/reconciliation/reconciliation.service.js';
import * as savings from '../../src/modules/savings/savings.service.js';
import * as susu from '../../src/modules/susu/susu.service.js';
import { accraDay } from '../../src/lib/time.js';
import {
  asOfficer,
  makeCollector,
  makeCustomer,
  makeTeller,
  setupDb,
  teardownDb,
} from './helpers.js';
import type { AccessTokenPayload } from '../../src/modules/auth/auth.service.js';

beforeAll(setupDb);
afterAll(teardownDb);

const officer = asOfficer();
const today = accraDay();

/** Gives the collector a customer with an open susu account, and collects once. */
async function collectSusu(collector: AccessTokenPayload, daily: number, days = 1) {
  const customerId = await makeCustomer(false, new Types.ObjectId(collector.sub));
  const account = await susu.openAccount(officer, customerId, daily);
  await susu.recordDeposit(
    collector,
    new Types.ObjectId(account.id),
    daily * days,
    randomUUID(),
    'cash',
  );
  return customerId;
}

/**
 * End-of-day cash handover (client request 2026-08-21). Field cash means susu
 * + savings deposits only — loans and hire purchase are collected at the
 * office. A shortage is recorded and reported, never blocked.
 */
/**
 * Who counts in whose day (client decision, 10 Sep 2026). The cash walks a
 * chain: a collector hands to a teller, a teller hands to the office. Nobody
 * counts in their own.
 */
describe('the handover chain', () => {
  it('lets a teller count in a collector’s day', async () => {
    const teller = await makeTeller();
    const collector = await makeCollector('Chain Collector');
    await collectSusu(collector, 3_000);
    const declared = await recon.declareDay(collector, { accraDay: today, declaredAmount: 3_000 });

    const done = await recon.confirmDay(teller, new Types.ObjectId(declared.id), {
      receivedAmount: 3_000,
    });
    expect(done.status).toBe('reconciled');
    expect(done.receivedById).toBe(teller.sub);
  });

  it('refuses a teller the day another teller declared — that one is the office’s', async () => {
    const first = await makeTeller('First Teller');
    const second = await makeTeller('Second Teller');
    const declared = await recon.declareDay(first, { accraDay: today, declaredAmount: 0 });

    await expect(
      recon.confirmDay(second, new Types.ObjectId(declared.id), { receivedAmount: 0 }),
    ).rejects.toMatchObject({ code: 'NOT_YOUR_HANDOVER' });

    // The office counts that one in.
    const done = await recon.confirmDay(officer, new Types.ObjectId(declared.id), {
      receivedAmount: 0,
    });
    expect(done.status).toBe('reconciled');
  });

  it('never lets anyone count in their own day', async () => {
    const teller = await makeTeller('Self Teller');
    const declared = await recon.declareDay(teller, { accraDay: today, declaredAmount: 0 });
    await expect(
      recon.confirmDay(teller, new Types.ObjectId(declared.id), { receivedAmount: 0 }),
    ).rejects.toMatchObject({ code: 'SELF_RECEIPT' });
  });

  it('says whose day each row is, so the screen can offer the count to the right person', async () => {
    // Without this the counter cannot tell a collector's handover from another
    // teller's, and would have to draw the confirm control for both and let
    // the API refuse half of them.
    const teller = await makeTeller('Labelled Teller');
    const collector = await makeCollector('Labelled Collector');
    await recon.declareDay(teller, { accraDay: today, declaredAmount: 0 });
    await recon.declareDay(collector, { accraDay: today, declaredAmount: 0 });

    const list = await recon.listReconciliations(officer, { page: 1, limit: 100 });
    const roleOf = (sub: string) => list.items.find((r) => r.collectorId === sub)?.collectorRole;

    expect(roleOf(teller.sub)).toBe('teller');
    expect(roleOf(collector.sub)).toBe('collector');
  });
});

describe('expected cash for a day', () => {
  it('adds up cash susu and savings deposits taken by that collector', async () => {
    const collector = await makeCollector();
    await collectSusu(collector, 2_000); // 2,000 susu

    const customerId = await makeCustomer(false, new Types.ObjectId(collector.sub));
    const { account } = await savings.openAccount(
      officer,
      customerId,
      undefined,
      undefined,
      'cash',
      'standard',
    );
    await savings.deposit(collector, new Types.ObjectId(account.id), 3_000, randomUUID(), 'cash');

    const expected = await recon.expectedForDay(new Types.ObjectId(collector.sub), today);
    expect(expected.susu).toBe(2_000);
    expect(expected.savings).toBe(3_000);
    expect(expected.total).toBe(5_000);
    expect(expected.entries).toBe(2);
  });

  it('counts only this collector — another collector’s round is not their cash', async () => {
    const mine = await makeCollector();
    const theirs = await makeCollector();
    await collectSusu(mine, 1_000);
    await collectSusu(theirs, 7_000);

    const expected = await recon.expectedForDay(new Types.ObjectId(mine.sub), today);
    expect(expected.total).toBe(1_000);
  });

  it('excludes non-cash deposits — they never passed through their hands', async () => {
    const collector = await makeCollector();
    const customerId = await makeCustomer(false, new Types.ObjectId(collector.sub));
    const account = await susu.openAccount(officer, customerId, 1_000);
    const id = new Types.ObjectId(account.id);

    await susu.recordDeposit(collector, id, 1_000, randomUUID(), 'cash');
    await susu.recordDeposit(collector, id, 1_000, randomUUID(), 'paystack');

    const expected = await recon.expectedForDay(new Types.ObjectId(collector.sub), today);
    expect(expected.total).toBe(1_000); // the paystack deposit is not field cash
  });

  it('is zero for a collector who collected nothing', async () => {
    const collector = await makeCollector();
    const expected = await recon.expectedForDay(new Types.ObjectId(collector.sub), today);
    expect(expected.total).toBe(0);
    expect(expected.entries).toBe(0);
  });
});

describe('closing the day', () => {
  it('runs declare → confirm and records a clean balance', async () => {
    const collector = await makeCollector();
    await collectSusu(collector, 5_000);

    const declared = await recon.declareDay(collector, { declaredAmount: 5_000 });
    expect(declared.status).toBe('declared');
    expect(declared.expectedAmount).toBe(5_000);
    expect(declared.receivedAmount).toBeUndefined();

    const confirmed = await recon.confirmDay(officer, new Types.ObjectId(declared.id), {
      receivedAmount: 5_000,
    });
    expect(confirmed.status).toBe('reconciled');
    expect(confirmed.variance).toBe(0);
    expect(confirmed.declaredVsReceived).toBe(0);
    expect(confirmed.receivedById).toBe(officer.sub);
  });

  it('records a shortage without blocking anything', async () => {
    const collector = await makeCollector();
    await collectSusu(collector, 10_000);

    const declared = await recon.declareDay(collector, {
      declaredAmount: 9_000,
      declaredNote: 'One customer paid short',
    });
    const confirmed = await recon.confirmDay(officer, new Types.ObjectId(declared.id), {
      receivedAmount: 9_000,
      varianceReason: 'Collector short GHS 10',
    });

    expect(confirmed.variance).toBe(-1_000); // negative = short
    expect(confirmed.declaredVsReceived).toBe(0);
    expect(confirmed.varianceReason).toBe('Collector short GHS 10');

    // The collector can still work: a fresh collection is unaffected.
    await expect(collectSusu(collector, 1_000)).resolves.toBeDefined();
  });

  it('records an overage and a collector/receiver miscount separately', async () => {
    const collector = await makeCollector();
    await collectSusu(collector, 4_000);

    const declared = await recon.declareDay(collector, { declaredAmount: 3_000 });
    const confirmed = await recon.confirmDay(officer, new Types.ObjectId(declared.id), {
      receivedAmount: 5_000,
    });

    expect(confirmed.variance).toBe(1_000); // 5,000 in vs 4,000 expected — over
    expect(confirmed.declaredVsReceived).toBe(2_000); // collector under-counted by 2,000
  });

  it('recomputes expected at confirmation, so a correction in between counts', async () => {
    const collector = await makeCollector();
    const customerId = await makeCustomer(false, new Types.ObjectId(collector.sub));
    const account = await susu.openAccount(officer, customerId, 1_000);
    const accountId = new Types.ObjectId(account.id);
    const deposit = await susu.recordDeposit(collector, accountId, 5_000, randomUUID(), 'cash');

    const declared = await recon.declareDay(collector, { declaredAmount: 5_000 });
    expect(declared.expectedAmount).toBe(5_000);

    // The office corrects the deposit down to 3,000 before taking the cash.
    await susu.updateDeposit(officer, accountId, new Types.ObjectId(deposit.deposit.id), 3_000);

    const confirmed = await recon.confirmDay(officer, new Types.ObjectId(declared.id), {
      receivedAmount: 3_000,
    });
    expect(confirmed.expectedAmount).toBe(3_000);
    expect(confirmed.variance).toBe(0);
  });

  it('lets a collector close only their own day, once', async () => {
    const collector = await makeCollector();
    await recon.declareDay(collector, { declaredAmount: 0 });

    await expect(recon.declareDay(collector, { declaredAmount: 0 })).rejects.toMatchObject({
      code: 'ALREADY_DECLARED',
      status: 409,
    });
    await expect(recon.declareDay(officer, { declaredAmount: 0 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('refuses to close a day that has not happened', async () => {
    const collector = await makeCollector();
    const tomorrow = accraDay(new Date(Date.now() + 24 * 60 * 60 * 1000));
    await expect(
      recon.declareDay(collector, { accraDay: tomorrow, declaredAmount: 0 }),
    ).rejects.toMatchObject({ code: 'FUTURE_DAY' });
  });

  it('refuses to let a collector confirm receipt of their own cash', async () => {
    const collector = await makeCollector();
    const declared = await recon.declareDay(collector, { declaredAmount: 1_000 });
    await expect(
      recon.confirmDay(collector, new Types.ObjectId(declared.id), { receivedAmount: 1_000 }),
    ).rejects.toMatchObject({ code: 'SELF_RECEIPT', status: 403 });
  });

  it('refuses to confirm the same day twice', async () => {
    const collector = await makeCollector();
    const declared = await recon.declareDay(collector, { declaredAmount: 0 });
    const id = new Types.ObjectId(declared.id);
    await recon.confirmDay(officer, id, { receivedAmount: 0 });
    await expect(recon.confirmDay(officer, id, { receivedAmount: 0 })).rejects.toMatchObject({
      code: 'ALREADY_RECONCILED',
      status: 409,
    });
  });
});

describe('variance reporting', () => {
  it('separates shortfalls from overages instead of only netting them', async () => {
    const steady = await makeCollector('Steady');
    const swingy = await makeCollector('Swingy');

    // Steady balances; Swingy is short one day and over the next by the same
    // amount, so netting alone would make them look identical.
    for (const [collector, day, expectedAmount, received] of [
      [steady, '2026-08-18', 5_000, 5_000],
      [swingy, '2026-08-18', 5_000, 4_000],
      [swingy, '2026-08-19', 5_000, 6_000],
    ] as const) {
      await ReconciliationModel.create({
        collectorId: new Types.ObjectId(collector.sub),
        accraDay: day,
        expectedAmount,
        expectedBreakdown: { susu: expectedAmount, savings: 0 },
        declaredAmount: received,
        declaredAt: new Date(),
        receivedAmount: received,
        receivedById: new Types.ObjectId(officer.sub),
        receivedAt: new Date(),
        variance: received - expectedAmount,
        declaredVsReceived: 0,
        status: 'reconciled',
      });
    }

    const report = await recon.varianceReport({
      from: '2026-08-18',
      to: '2026-08-19',
      format: 'json',
    });

    const swingyRow = report.rows.find((r) => r.collectorName === 'Swingy');
    const steadyRow = report.rows.find((r) => r.collectorName === 'Steady');
    expect(swingyRow?.netVariance).toBe(0);
    expect(swingyRow?.totalShort).toBe(1_000);
    expect(swingyRow?.totalOver).toBe(1_000);
    expect(swingyRow?.daysWithVariance).toBe(2);

    expect(steadyRow?.netVariance).toBe(0);
    expect(steadyRow?.totalShort).toBe(0);
    expect(steadyRow?.daysWithVariance).toBe(0);

    expect(report.totals.totalShort).toBe(1_000);
    expect(report.totals.totalOver).toBe(1_000);
  });
});
