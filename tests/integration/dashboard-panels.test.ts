import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { accraDay } from '../../src/lib/time.js';
import {
  LoanModel,
  PaystackChargeModel,
  ReconciliationModel,
  SusuAccountModel,
  SusuDepositModel,
} from '../../src/models/index.js';
import { dashboardAlerts } from '../../src/modules/dashboard/alerts.service.js';
import { dashboardMetrics } from '../../src/modules/dashboard/dashboard.service.js';
import { cashSeries, collectionEfficiency } from '../../src/modules/dashboard/series.service.js';
import { listTransactions } from '../../src/modules/reports/transactions.service.js';
import { makeCustomer, setupDb, teardownDb } from './helpers.js';

beforeAll(setupDb);
afterAll(teardownDb);

const staffId = new Types.ObjectId();
const DAY_MS = 24 * 60 * 60 * 1000;
const today = accraDay();
const yesterday = accraDay(new Date(Date.now() - DAY_MS));

describe('dashboard series', () => {
  it('returns every bucket in the range, zero-filled where nothing happened', async () => {
    const from = accraDay(new Date(Date.now() - 4 * DAY_MS));
    const series = await cashSeries({ from, to: today, bucket: 'day' });

    expect(series.points).toHaveLength(5);
    expect(series.points.map((p) => p.key)).toEqual([...series.points.map((p) => p.key)].sort());
    // A day with no activity is present with zeroes, not omitted — otherwise a
    // line chart draws straight across it.
    expect(series.points.every((p) => typeof p.cashIn.amount === 'number')).toBe(true);
  });

  it('keeps expected/received at zero until a day is reconciled', async () => {
    const collectorId = new Types.ObjectId();
    await ReconciliationModel.create({
      collectorId,
      accraDay: yesterday,
      expectedAmount: 50_000,
      expectedBreakdown: { susu: 50_000, savings: 0 },
      declaredAmount: 50_000,
      declaredAt: new Date(),
      status: 'declared', // declared but NOT confirmed by the office
    });

    const before = await cashSeries({ from: yesterday, to: yesterday, bucket: 'day' });
    expect(before.points[0]?.expected).toBe(0);
    expect(before.points[0]?.received).toBe(0);

    await ReconciliationModel.updateOne(
      { collectorId, accraDay: yesterday },
      {
        $set: {
          status: 'reconciled',
          receivedAmount: 48_000,
          receivedById: staffId,
          receivedAt: new Date(),
          variance: -2_000,
        },
      },
    );

    const after = await cashSeries({ from: yesterday, to: yesterday, bucket: 'day' });
    expect(after.points[0]?.expected).toBe(50_000);
    expect(after.points[0]?.received).toBe(48_000);
  });

  it('rolls daily reconciliations up into a month bucket', async () => {
    const series = await cashSeries({ from: yesterday, to: today, bucket: 'month' });
    const monthKey = today.slice(0, 7);
    const point = series.points.find((p) => p.key === monthKey);
    expect(point).toBeDefined();
    expect(series.totals.expected).toBe(series.points.reduce((sum, p) => sum + p.expected, 0));
  });

  it('reports efficiency as received over expected, from reconciled days only', async () => {
    const efficiency = await collectionEfficiency(yesterday, today);
    expect(efficiency.expected).toBe(50_000);
    expect(efficiency.received).toBe(48_000);
    expect(efficiency.percent).toBe(96);
    expect(efficiency.netVariance).toBe(-2_000);
    expect(efficiency.daysWithVariance).toBe(1);
  });

  it('returns a null percentage rather than a fake one when nothing was due', async () => {
    // 2020 has no reconciliations at all — dividing by zero would be a lie.
    const efficiency = await collectionEfficiency('2020-01-01', '2020-01-31');
    expect(efficiency.expected).toBe(0);
    expect(efficiency.percent).toBeNull();
  });
});

describe('dashboard summary', () => {
  it('derives the KPI tiles from the detail blocks', async () => {
    const metrics = await dashboardMetrics();

    expect(metrics.kpis.totalCustomers).toBe(metrics.portfolio.customersActive);
    expect(metrics.kpis.activeAccounts).toBe(
      metrics.portfolio.susu.activeAccounts +
        metrics.portfolio.savings.activeAccounts +
        metrics.portfolio.loans.active +
        metrics.portfolio.hirePurchase.active,
    );
    expect(metrics.kpis.inArrears).toBe(
      metrics.portfolio.loans.arrears + metrics.portfolio.hirePurchase.inArrears,
    );
    expect(metrics.kpis.amountCollectedToday).toBe(metrics.today.cashIn.amount);
    expect(metrics.kpis.pendingSusuPayouts).toEqual(metrics.portfolio.susu.pendingPayout);
  });

  it('reports no change rather than a fake percentage when yesterday took nothing', async () => {
    const metrics = await dashboardMetrics();
    if (metrics.yesterday.cashIn.amount === 0) {
      expect(metrics.kpis.amountCollectedChangePercent).toBeNull();
    } else {
      expect(typeof metrics.kpis.amountCollectedChangePercent).toBe('number');
    }
  });
});

describe('pending money in the feed', () => {
  it('shows unapplied Paystack charges but never counts them as cash', async () => {
    const customerId = await makeCustomer();
    const account = await SusuAccountModel.create({
      accountNumber: '900001',
      customerId,
      dailyAmount: 1_000,
      openedById: staffId,
    });
    // Real, settled money: a cash deposit.
    await SusuDepositModel.create({
      accountId: account._id,
      customerId,
      collectorId: staffId,
      amount: 1_000,
      daysCovered: 1,
      seqStart: 1,
      seqEnd: 1,
      channel: 'cash',
    });
    // Money still in flight: initiated, Paystack has not confirmed.
    await PaystackChargeModel.create({
      reference: `yadah-${new Types.ObjectId().toHexString()}`,
      status: 'pending',
      executionStatus: 'pending',
      kind: 'susu-deposit',
      targetId: account._id,
      customerId,
      amount: 5_000,
      phone: '0241234567',
      provider: 'mtn',
      email: 'test@example.com',
      initiatedById: staffId,
      initiatedByRole: 'admin',
    });

    const without = await listTransactions({
      page: 1,
      limit: 50,
      customerId,
      includePending: false,
      format: 'json',
    });
    const with_ = await listTransactions({
      page: 1,
      limit: 50,
      customerId,
      includePending: true,
      format: 'json',
    });

    expect(without.items).toHaveLength(1);
    expect(without.items[0]?.status).toBe('completed');

    expect(with_.items).toHaveLength(2);
    expect(with_.items.filter((i) => i.status === 'pending')).toHaveLength(1);
    // The pending GHS 50 is visible but does NOT inflate cash in.
    expect(with_.totals.in.amount).toBe(without.totals.in.amount);
    expect(with_.totals.in.amount).toBe(1_000);
  });

  it('does not double-count a charge once it has been applied', async () => {
    const customerId = await makeCustomer();
    const account = await SusuAccountModel.create({
      accountNumber: '900002',
      customerId,
      dailyAmount: 1_000,
      openedById: staffId,
    });
    const deposit = await SusuDepositModel.create({
      accountId: account._id,
      customerId,
      collectorId: staffId,
      amount: 2_000,
      daysCovered: 2,
      seqStart: 1,
      seqEnd: 2,
      channel: 'paystack',
    });
    await PaystackChargeModel.create({
      reference: `yadah-${new Types.ObjectId().toHexString()}`,
      status: 'success',
      executionStatus: 'applied', // already became the deposit above
      kind: 'susu-deposit',
      targetId: account._id,
      customerId,
      amount: 2_000,
      phone: '0241234567',
      provider: 'mtn',
      email: 'test@example.com',
      initiatedById: staffId,
      initiatedByRole: 'admin',
      resultRecordId: deposit._id,
    });

    const feed = await listTransactions({
      page: 1,
      limit: 50,
      customerId,
      includePending: true,
      format: 'json',
    });
    // One row, not two: the applied charge IS the deposit.
    expect(feed.items).toHaveLength(1);
    expect(feed.totals.in.amount).toBe(2_000);
  });
});

describe('dashboard alerts', () => {
  it('surfaces susu payouts waiting, with the money behind them', async () => {
    const customerId = await makeCustomer();
    await SusuAccountModel.create({
      accountNumber: '900003',
      customerId,
      dailyAmount: 1_000,
      depositsCount: 31,
      totalDeposited: 31_000,
      status: 'pending-payout',
      payoutRemaining: 30_000,
      openedById: staffId,
    });

    const { alerts } = await dashboardAlerts();
    const payout = alerts.find((a) => a.key === 'susu-payouts-pending');
    expect(payout).toBeDefined();
    expect(payout?.count).toBe(1);
    expect(payout?.amount).toBe(30_000);
    expect(payout?.target).toEqual({ module: 'susu', filter: { status: 'pending-payout' } });
  });

  it('flags mobile money taken but not applied as critical', async () => {
    const customerId = await makeCustomer();
    await PaystackChargeModel.create({
      reference: `yadah-${new Types.ObjectId().toHexString()}`,
      status: 'success',
      executionStatus: 'failed', // money taken, could not be posted
      kind: 'savings-deposit',
      targetId: new Types.ObjectId(),
      customerId,
      amount: 7_500,
      phone: '0241234567',
      provider: 'mtn',
      email: 'test@example.com',
      initiatedById: staffId,
      initiatedByRole: 'admin',
    });

    const { alerts } = await dashboardAlerts();
    const stuck = alerts.find((a) => a.key === 'paystack-unapplied');
    expect(stuck?.severity).toBe('critical');
    expect(stuck?.amount).toBe(7_500);
    // Critical alerts sort ahead of warnings and info.
    expect(alerts[0]?.severity).toBe('critical');
  });

  it('omits alerts with nothing behind them', async () => {
    const { alerts } = await dashboardAlerts();
    // Nothing in this suite creates an HP agreement in arrears.
    expect(alerts.find((a) => a.key === 'hp-in-arrears')).toBeUndefined();
    expect(alerts.every((a) => a.count > 0)).toBe(true);
  });

  it('reports loans in arrears as a share of the whole credit book', async () => {
    const customerId = await makeCustomer(true);
    await LoanModel.create({
      customerId,
      tier: 'small',
      principal: 500_000,
      durationMonths: 3,
      ratePercent: 30,
      interestAmount: 150_000,
      totalDue: 650_000,
      totalRepaid: 50_000,
      status: 'arrears',
      appliedAt: new Date(Date.now() - 200 * DAY_MS),
      dueDate: new Date(Date.now() - 100 * DAY_MS),
    });

    const { alerts } = await dashboardAlerts();
    const arrears = alerts.find((a) => a.key === 'loans-in-arrears');
    expect(arrears?.count).toBe(1);
    expect(arrears?.amount).toBe(600_000);
    // Over 30 days past due escalates the alert.
    expect(arrears?.severity).toBe('critical');
    expect(arrears?.body).toContain('% of the credit book');
  });
});
