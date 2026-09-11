import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { PaystackChargeModel, SusuAccountModel } from '../../src/models/index.js';
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

describe('susu closing commission on the ledger', () => {
  it('shows the one-day charge on the payout that closed the account', async () => {
    const customerId = await makeCustomer();
    const account = await susu.openAccount(officer, customerId, DAILY);
    const id = new Types.ObjectId(account.id);
    await susu.recordDeposit(officer, id, DAILY * 10, randomUUID(), 'cash');

    const closure = await susu.closeAccount(officer, id);
    expect(closure.commission).toBe(DAILY);
    expect(closure.payout).toBe(DAILY * 9);

    const feed = await feedFor(customerId);
    const payout = feed.items.find((t) => t.type === 'susu-payout');
    expect(payout?.amount).toBe(DAILY * 9);
    expect(payout?.fee).toBe(DAILY);

    // The deposit that funded it charges nothing.
    expect(feed.items.find((t) => t.type === 'susu-deposit')?.fee).toBe(0);
    // And the commission counts as revenue kept, like a savings fee.
    expect(feed.totals.feesCollected).toBe(DAILY);
  });

  it('charges it once even when the payout is handed over in instalments', async () => {
    const customerId = await makeCustomer();
    const account = await susu.openAccount(officer, customerId, DAILY);
    const id = new Types.ObjectId(account.id);
    await susu.recordDeposit(officer, id, DAILY * 10, randomUUID(), 'cash');

    // Stage it the way a transfer or a loan repayment leaves an account:
    // stopped, commission taken, value still awaiting disbursement.
    await SusuAccountModel.updateOne(
      { _id: id },
      {
        $set: {
          status: 'pending-payout',
          commissionAmount: DAILY,
          payoutAmount: DAILY * 9,
          payoutRemaining: DAILY * 9,
        },
      },
    );
    await susu.payoutPending(officer, id, DAILY * 4, randomUUID());
    await susu.payoutPending(officer, id, DAILY * 5, randomUUID());

    const feed = await feedFor(customerId);
    const payouts = feed.items.filter((t) => t.type === 'susu-payout');
    expect(payouts).toHaveLength(2);
    // Neither instalment re-charges the commission that was taken at the stop.
    expect(payouts.map((p) => p.fee)).toEqual([0, 0]);
    expect(feed.totals.feesCollected).toBe(0);
  });

  it('still records the closure when nothing is left to hand over', async () => {
    const customerId = await makeCustomer();
    const account = await susu.openAccount(officer, customerId, DAILY);
    const id = new Types.ObjectId(account.id);
    await susu.recordDeposit(officer, id, DAILY * 5, randomUUID(), 'cash');
    // Take the maximum, which leaves exactly one day reserved for commission.
    await susu.withdrawPartial(officer, id, DAILY * 4, randomUUID());

    const closure = await susu.closeAccount(officer, id);
    expect(closure.payout).toBe(0);
    expect(closure.commission).toBe(DAILY);

    const feed = await feedFor(customerId);
    const payout = feed.items.find((t) => t.type === 'susu-payout');
    // The row exists precisely so the charge is auditable — without it a
    // maximum-withdrawal closure left no trace on the ledger at all.
    expect(payout).toBeDefined();
    expect(payout?.amount).toBe(0);
    expect(payout?.fee).toBe(DAILY);

    // A partial withdrawal never charges.
    expect(feed.items.find((t) => t.type === 'susu-withdrawal')?.fee).toBe(0);
  });

  it('charges nothing on a termination', async () => {
    const customerId = await makeCustomer();
    // Termination is only reachable while the balance cannot cover one day's
    // commission — which, since deposits are whole multiples of the daily
    // amount and a withdrawal always reserves one day, means an empty cycle.
    const account = await susu.openAccount(officer, customerId, DAILY);
    const id = new Types.ObjectId(account.id);

    const terminated = await susu.terminateAccount(officer, id, 'opened in error');
    expect(terminated.refund).toBe(0);

    const stored = await SusuAccountModel.findById(id);
    expect(stored?.status).toBe('terminated');
    expect(stored?.commissionAmount).toBe(0);

    const feed = await feedFor(customerId);
    for (const row of feed.items.filter((t) => t.type === 'susu-payout')) {
      expect(row.fee).toBe(0);
    }
    expect(feed.totals.feesCollected).toBe(0);
  });
});

describe('who recorded a transaction', () => {
  it('names a staff member for a counter deposit', async () => {
    const customerId = await makeCustomer();
    const account = await susu.openAccount(officer, customerId, DAILY);
    await susu.recordDeposit(officer, new Types.ObjectId(account.id), DAILY, randomUUID(), 'cash');

    const feed = await feedFor(customerId);
    const row = feed.items.find((t) => t.type === 'susu-deposit');
    expect(row?.recordedByKind).toBe('staff');
    expect(row?.recordedById).toBe(officer.sub);
  });

  it('names the customer for a portal payment they made themselves', async () => {
    const customerId = await makeCustomer();
    const account = await susu.openAccount(officer, customerId, DAILY);
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
    const account = await susu.openAccount(officer, customerId, DAILY);
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
    const account = await susu.openAccount(officer, customerId, DAILY);
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
