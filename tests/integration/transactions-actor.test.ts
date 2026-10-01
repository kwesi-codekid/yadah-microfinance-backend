import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { PaystackChargeModel } from '../../src/models/index.js';
import {
  listTransactions,
  transactionsCsvRows,
} from '../../src/modules/reports/transactions.service.js';
import {
  transactionsQuery,
  type TransactionsQuery,
} from '../../src/modules/reports/reports.schemas.js';
import * as susu from '../../src/modules/susu/susu.service.js';
import { asOfficer, makeCustomer, setupDb, teardownDb } from './helpers.js';

beforeAll(setupDb);
afterAll(teardownDb);

const officer = asOfficer();
/** The well-known actor automated moves and applied portal charges run as. */
const SYSTEM_ACTOR_HEX = '000000000000000000000000';
const DAILY = 1_000;

function query(overrides: Record<string, unknown> = {}): TransactionsQuery {
  return transactionsQuery.parse(overrides);
}

async function feedFor(customerId: Types.ObjectId) {
  const feed = await listTransactions(query({ customerId: customerId.toHexString() }));
  return feed;
}

describe('susu commission on the ledger', () => {
  it('shows the commission on the deposit that completed a cycle', async () => {
    const customerId = await makeCustomer();
    const { account } = await susu.openAccount(officer, customerId, DAILY);
    const id = new Types.ObjectId(account.id);
    await susu.recordDeposit(officer, id, DAILY * 30, randomUUID(), 'cash', undefined, undefined, [
      { planId: account.plans[0]!.id, payments: 30 },
    ]);
    const last = await susu.recordDeposit(officer, id, DAILY, randomUUID(), 'cash');
    expect(last.deposit.commissionAmount).toBe(DAILY);

    const feed = await feedFor(customerId);
    const rows = feed.items.filter((t) => t.type === 'susu-deposit');
    expect(rows.map((r) => r.fee).sort()).toEqual([0, DAILY]);
    // Cash in is the whole of what was handed over; the commission is what
    // the company kept of it.
    expect(feed.totals.in.amount).toBe(DAILY * 31);
    expect(feed.totals.feesCollected).toBe(DAILY);
  });

  it('shows the commission for cycles in progress on the payout that closed the account', async () => {
    const customerId = await makeCustomer();
    const { account } = await susu.openAccount(officer, customerId, DAILY);
    const id = new Types.ObjectId(account.id);
    await susu.recordDeposit(officer, id, DAILY * 10, randomUUID(), 'cash', undefined, undefined, [
      { planId: account.plans[0]!.id, payments: 10 },
    ]);

    const closure = await susu.closeAccount(officer, id);
    expect(closure.commission).toBe(DAILY);
    expect(closure.payout).toBe(DAILY * 9);

    const feed = await feedFor(customerId);
    const payout = feed.items.find((t) => t.type === 'susu-payout');
    expect(payout?.amount).toBe(DAILY * 9);
    expect(payout?.fee).toBe(DAILY);
    expect(feed.items.find((t) => t.type === 'susu-deposit')?.fee).toBe(0);
    expect(feed.totals.feesCollected).toBe(DAILY);
  });

  it('a withdrawal never charges; a plan stopped mid-cycle charges with no cash moving', async () => {
    const customerId = await makeCustomer();
    const { account } = await susu.openAccount(officer, customerId, DAILY);
    const id = new Types.ObjectId(account.id);
    await susu.recordDeposit(officer, id, DAILY * 5, randomUUID(), 'cash', undefined, undefined, [
      { planId: account.plans[0]!.id, payments: 5 },
    ]);
    await susu.withdraw(officer, id, DAILY * 4, randomUUID());
    await susu.stopPlan(officer, id, new Types.ObjectId(account.plans[0]!.id));

    const feed = await feedFor(customerId);
    expect(feed.items.find((t) => t.type === 'susu-withdrawal')?.fee).toBe(0);
    const stop = feed.items.find((t) => t.type === 'susu-commission');
    expect(stop).toMatchObject({ amount: 0, fee: DAILY, direction: 'internal' });
    expect(feed.totals.out.amount).toBe(DAILY * 4);
    expect(feed.totals.feesCollected).toBe(DAILY);
  });
});

describe('who recorded a transaction', () => {
  it('names a staff member for a counter deposit', async () => {
    const customerId = await makeCustomer();
    const { account } = await susu.openAccount(officer, customerId, DAILY);
    await susu.recordDeposit(officer, new Types.ObjectId(account.id), DAILY, randomUUID(), 'cash');

    const feed = await feedFor(customerId);
    const row = feed.items.find((t) => t.type === 'susu-deposit');
    expect(row?.recordedByKind).toBe('staff');
    expect(row?.recordedById).toBe(officer.sub);
  });

  it('names the customer for a portal payment they made themselves', async () => {
    const customerId = await makeCustomer();
    const { account } = await susu.openAccount(officer, customerId, DAILY);
    const reference = `ref_${randomUUID()}`;

    // A portal charge: raised by the customer, applied by the system on the
    // webhook's word, under the idempotency key that embeds the reference.
    await PaystackChargeModel.create({
      reference,
      customerId,
      kind: 'susu-deposit',
      targetId: new Types.ObjectId(account.id),
      amount: DAILY,
      status: 'success',
      executionStatus: 'applied',
      phone: '0241234567',
      provider: 'mtn',
      email: 'customer@example.test',
      initiatedById: customerId,
      initiatedByRole: 'customer',
    });
    await susu.recordDeposit(
      { sub: SYSTEM_ACTOR_HEX, role: 'admin' },
      new Types.ObjectId(account.id),
      DAILY,
      `paystack:${reference}`,
      'paystack',
    );

    const feed = await feedFor(customerId);
    const row = feed.items.find((t) => t.type === 'susu-deposit');
    // Before this, a customer paying for themselves read as 'System'.
    expect(row?.recordedByKind).toBe('customer');
    expect(row?.recordedById).toBe(customerId.toHexString());
    expect(row?.recordedByName).not.toBe('System');
    expect(row?.recordedByName).toBeTruthy();
  });

  it('still says system for an automated move with no charge behind it', async () => {
    const customerId = await makeCustomer();
    const { account } = await susu.openAccount(officer, customerId, DAILY);
    await susu.recordDeposit(
      { sub: SYSTEM_ACTOR_HEX, role: 'admin' },
      new Types.ObjectId(account.id),
      DAILY,
      randomUUID(),
      'cash',
    );

    const feed = await feedFor(customerId);
    const row = feed.items.find((t) => t.type === 'susu-deposit');
    expect(row?.recordedByKind).toBe('system');
    expect(row?.recordedByName).toBe('System');
  });

  it('keeps the spreadsheet columns in a stable order', async () => {
    const customerId = await makeCustomer();
    const { account } = await susu.openAccount(officer, customerId, DAILY);
    await susu.recordDeposit(officer, new Types.ObjectId(account.id), DAILY, randomUUID(), 'cash');

    const rows = await transactionsCsvRows(query({ customerId: customerId.toHexString() }));
    // The office reads these by position. New columns append; nothing moves.
    expect(Object.keys(rows[0] ?? {})).toEqual([
      'date',
      'module',
      'type',
      'direction',
      'status',
      'amount',
      'fee',
      'channel',
      'detail',
      'customerName',
      'accountRef',
      'balanceAfter',
      'recordedBy',
      'recordedByType',
    ]);
  });
});
