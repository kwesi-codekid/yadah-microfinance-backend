import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import {
  listTransactions,
  scopeTransactionsQuery,
} from '../../src/modules/reports/transactions.service.js';
import { transactionsQuery } from '../../src/modules/reports/reports.schemas.js';
import * as savings from '../../src/modules/savings/savings.service.js';
import * as susu from '../../src/modules/susu/susu.service.js';
import {
  asOfficer,
  makeCollector,
  makeCustomer,
  makeTeller,
  setupDb,
  teardownDb,
} from './helpers.js';

beforeAll(setupDb);
afterAll(teardownDb);

function query(overrides: Record<string, unknown> = {}) {
  return transactionsQuery.parse(overrides);
}

describe('the ledger narrowed to who recorded each entry', () => {
  it("shows one member of staff's money in and money out, and nobody else's", async () => {
    const teller = await makeTeller('Day Teller');
    const other = await makeTeller('Other Teller');
    const customerId = await makeCustomer();

    // In: a savings account opened with GHS 200; out: GHS 50 withdrawn.
    const opened = await savings.openAccount(teller, customerId, 20_000, randomUUID(), 'cash');
    await savings.withdraw(teller, new Types.ObjectId(opened.account.id), 5_000, randomUUID());

    // A susu deposit by somebody else must not show up in the teller's rows.
    const susuAccount = await susu.openAccount(other, customerId, 1_000);
    await susu.recordDeposit(
      other,
      new Types.ObjectId(susuAccount.id),
      1_000,
      randomUUID(),
      'cash',
    );

    const mine = await listTransactions(scopeTransactionsQuery(teller, query()));
    expect(mine.items.map((t) => t.type).sort()).toEqual(['savings-deposit', 'savings-withdrawal']);
    expect(mine.items.every((t) => t.recordedById === teller.sub)).toBe(true);
    expect(mine.totals.in).toEqual({ count: 1, amount: 20_000 });
    expect(mine.totals.out).toEqual({ count: 1, amount: 5_000 });

    const theirs = await listTransactions(scopeTransactionsQuery(other, query()));
    expect(theirs.items.map((t) => t.type)).toEqual(['susu-deposit']);
    expect(theirs.totals.out.count).toBe(0);
  });

  it('pins a non-office caller to themselves even when they name someone else', async () => {
    const collector = await makeCollector('Pinned Collector');
    const teller = await makeTeller('Named Teller');
    const scoped = scopeTransactionsQuery(collector, query({ recordedById: teller.sub }));
    expect(scoped.recordedById?.toHexString()).toBe(collector.sub);
  });

  it('lets the office read the whole branch or a named member of staff', async () => {
    const teller = await makeTeller('Read By Office');
    const officer = asOfficer();
    expect(scopeTransactionsQuery(officer, query()).recordedById).toBeUndefined();
    expect(
      scopeTransactionsQuery(
        officer,
        query({ recordedById: teller.sub }),
      ).recordedById?.toHexString(),
    ).toBe(teller.sub);
  });

  it('returns an empty day for a date with nothing recorded', async () => {
    const teller = await makeTeller('Quiet Teller');
    const feed = await listTransactions(
      scopeTransactionsQuery(teller, query({ from: '2020-01-01', to: '2020-01-01' })),
    );
    expect(feed.items).toHaveLength(0);
    expect(feed.totals.in.amount).toBe(0);
    expect(feed.totals.out.amount).toBe(0);
  });
});
