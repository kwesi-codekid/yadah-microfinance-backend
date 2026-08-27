import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { accraDay } from '../../src/lib/time.js';
import * as collectors from '../../src/modules/collectors/collectors.service.js';
import * as savings from '../../src/modules/savings/savings.service.js';
import * as susu from '../../src/modules/susu/susu.service.js';
import { asOfficer, makeCollector, makeCustomer, setupDb, teardownDb } from './helpers.js';

beforeAll(setupDb);
afterAll(teardownDb);

const officer = asOfficer();
const today = accraDay();

describe('collector round sheet', () => {
  it('lists only the collector’s own customers, with what is still due', async () => {
    const collector = await makeCollector('Round Collector');
    const collectorId = new Types.ObjectId(collector.sub);

    const mine = await makeCustomer(false, collectorId);
    const someoneElses = await makeCustomer(); // no collector assigned
    await susu.openAccount(officer, mine, 2_000);
    await susu.openAccount(officer, someoneElses, 2_000);

    const round = await collectors.collectorRound(collector, today, undefined);
    expect(round.stops).toHaveLength(1);
    expect(round.stops[0]?.customerId).toBe(mine.toHexString());
    expect(round.stops[0]?.totalStillDue).toBe(2_000);
    expect(round.stops[0]?.done).toBe(false);
    expect(round.totals.expectedTotal).toBe(2_000);
    expect(round.totals.stillDueTotal).toBe(2_000);
  });

  it('marks a stop done once today’s deposit is recorded', async () => {
    const collector = await makeCollector('Done Collector');
    const collectorId = new Types.ObjectId(collector.sub);
    const customerId = await makeCustomer(false, collectorId);
    const account = await susu.openAccount(officer, customerId, 1_500);

    const before = await collectors.collectorRound(collector, today, undefined);
    expect(before.stops[0]?.done).toBe(false);

    await susu.recordDeposit(
      collector,
      new Types.ObjectId(account.id),
      1_500,
      randomUUID(),
      'cash',
    );

    const after = await collectors.collectorRound(collector, today, undefined);
    expect(after.stops[0]?.done).toBe(true);
    expect(after.stops[0]?.totalStillDue).toBe(0);
    expect(after.totals.collectedTotal).toBe(1_500);
    expect(after.totals.customersDone).toBe(1);
  });

  it('sums across a customer’s multiple susu accounts', async () => {
    const collector = await makeCollector('Multi Collector');
    const collectorId = new Types.ObjectId(collector.sub);
    const customerId = await makeCustomer(false, collectorId);
    await susu.openAccount(officer, customerId, 1_000);
    await susu.openAccount(officer, customerId, 3_000);

    const round = await collectors.collectorRound(collector, today, undefined);
    expect(round.stops[0]?.susu).toHaveLength(2);
    expect(round.stops[0]?.totalStillDue).toBe(4_000);
  });

  it('omits customers with nothing to collect', async () => {
    const collector = await makeCollector('Empty Collector');
    const collectorId = new Types.ObjectId(collector.sub);
    await makeCustomer(false, collectorId); // assigned, but no susu account

    const round = await collectors.collectorRound(collector, today, undefined);
    expect(round.stops).toHaveLength(0);
    expect(round.totals.customers).toBe(0);
  });

  it('pins a collector to themselves even when another id is passed', async () => {
    const collector = await makeCollector('Pinned Collector');
    const other = await makeCollector('Other Collector');
    const customerId = await makeCustomer(false, new Types.ObjectId(collector.sub));
    await susu.openAccount(officer, customerId, 1_000);

    // Asking for someone else's round returns their own.
    const round = await collectors.collectorRound(collector, today, new Types.ObjectId(other.sub));
    expect(round.collectorId).toBe(collector.sub);
    expect(round.stops).toHaveLength(1);
  });

  it('requires office callers to name a collector', async () => {
    await expect(collectors.collectorRound(officer, today, undefined)).rejects.toMatchObject({
      code: 'COLLECTOR_REQUIRED',
    });
  });
});

describe('collector day view', () => {
  it('combines susu and savings, and counts only cash toward handover', async () => {
    const collector = await makeCollector('Day Collector');
    const collectorId = new Types.ObjectId(collector.sub);
    const customerId = await makeCustomer(false, collectorId);

    const susuAccount = await susu.openAccount(officer, customerId, 1_000);
    await susu.recordDeposit(
      collector,
      new Types.ObjectId(susuAccount.id),
      1_000,
      randomUUID(),
      'cash',
    );

    const { account: savingsAccount } = await savings.openAccount(
      officer,
      customerId,
      undefined,
      undefined,
      'cash',
      'standard',
    );
    await savings.deposit(
      collector,
      new Types.ObjectId(savingsAccount.id),
      4_000,
      randomUUID(),
      'cash',
    );
    // Mobile money is real income but never reaches the collector's pocket.
    await savings.deposit(
      collector,
      new Types.ObjectId(savingsAccount.id),
      9_000,
      randomUUID(),
      'momo',
    );

    const day = await collectors.collectorDay(collector, today, undefined);
    expect(day.susu.amount).toBe(1_000);
    expect(day.savings.amount).toBe(13_000);
    // 1,000 susu cash + 4,000 savings cash. The 9,000 momo is excluded.
    expect(day.cashTotal).toBe(5_000);
    expect(day.entries).toHaveLength(3);
  });

  it('reports no reconciliation until the day is declared', async () => {
    const collector = await makeCollector('Undeclared Collector');
    const day = await collectors.collectorDay(collector, today, undefined);
    expect(day.reconciliation).toBeNull();
  });

  it('shows an empty day rather than failing', async () => {
    const collector = await makeCollector('Quiet Collector');
    const day = await collectors.collectorDay(collector, today, undefined);
    expect(day.susu).toEqual({ count: 0, amount: 0 });
    expect(day.savings).toEqual({ count: 0, amount: 0 });
    expect(day.cashTotal).toBe(0);
    expect(day.entries).toEqual([]);
  });
});
