import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import * as customers from '../../src/modules/customers/customers.service.js';
import * as savings from '../../src/modules/savings/savings.service.js';
import * as susu from '../../src/modules/susu/susu.service.js';
import { asOfficer, makeCollector, makeCustomer, setupDb, teardownDb } from './helpers.js';
import type { AccessTokenPayload } from '../../src/modules/auth/auth.service.js';

beforeAll(setupDb);
afterAll(teardownDb);

const officer = asOfficer();
const page = { page: 1, limit: 50 };

/**
 * The collector lock (client decision 2026-08-21): a collector may only see
 * and act on their own customers. These tests assert the hard 403, not just a
 * filtered-away result — a collector must never be able to touch someone
 * else's round even when they know the id.
 */
describe('collector scope lock', () => {
  let alice: AccessTokenPayload;
  let bob: AccessTokenPayload;
  let aliceCustomer: Types.ObjectId;
  let bobCustomer: Types.ObjectId;

  beforeAll(async () => {
    alice = await makeCollector('Alice');
    bob = await makeCollector('Bob');
    aliceCustomer = await makeCustomer(false, new Types.ObjectId(alice.sub));
    bobCustomer = await makeCustomer(false, new Types.ObjectId(bob.sub));
  });

  it('lists only the collector’s own customers, while the office sees both', async () => {
    const mine = await customers.listCustomers(alice, {
      ...page,
      format: 'json' as const,
    });
    const ids = mine.items.map((c) => c.id);
    expect(ids).toContain(aliceCustomer.toHexString());
    expect(ids).not.toContain(bobCustomer.toHexString());

    const all = await customers.listCustomers(officer, { ...page, format: 'json' as const });
    const allIds = all.items.map((c) => c.id);
    expect(allIds).toContain(aliceCustomer.toHexString());
    expect(allIds).toContain(bobCustomer.toHexString());
  });

  it('refuses a direct read of another collector’s customer', async () => {
    await expect(customers.getCustomer(alice, bobCustomer)).rejects.toMatchObject({
      code: 'CUSTOMER_NOT_ASSIGNED',
      status: 403,
    });
    await expect(customers.getCustomer(alice, aliceCustomer)).resolves.toMatchObject({
      id: aliceCustomer.toHexString(),
    });
  });

  it('refuses a susu deposit onto another collector’s customer', async () => {
    const account = await susu.openAccount(officer, bobCustomer, 1_000);
    const accountId = new Types.ObjectId(account.id);

    await expect(
      susu.recordDeposit(alice, accountId, 1_000, randomUUID(), 'cash'),
    ).rejects.toMatchObject({ code: 'CUSTOMER_NOT_ASSIGNED', status: 403 });

    // Bob, who owns the round, records it fine.
    const ok = await susu.recordDeposit(bob, accountId, 1_000, randomUUID(), 'cash');
    expect(ok.deposit.amount).toBe(1_000);
  });

  it('refuses collect-all against another collector’s customer', async () => {
    await expect(
      susu.collectAll(alice, bobCustomer, 1_000, randomUUID(), 'cash'),
    ).rejects.toMatchObject({ code: 'CUSTOMER_NOT_ASSIGNED', status: 403 });
  });

  it('refuses reading a susu account outside the round', async () => {
    const account = await susu.openAccount(officer, aliceCustomer, 1_000);
    const accountId = new Types.ObjectId(account.id);
    await expect(susu.getAccount(bob, accountId)).rejects.toMatchObject({
      code: 'CUSTOMER_NOT_ASSIGNED',
    });
    await expect(susu.getAccount(alice, accountId)).resolves.toMatchObject({ id: account.id });
  });

  it('an account-number search cannot reach outside the round', async () => {
    const account = await susu.openAccount(officer, bobCustomer, 1_000);
    const found = await susu.listAccounts(alice, {
      ...page,
      search: account.accountNumber,
      format: 'json' as const,
    });
    expect(found.items).toHaveLength(0);

    const bobSees = await susu.listAccounts(bob, {
      ...page,
      search: account.accountNumber,
      format: 'json' as const,
    });
    expect(bobSees.items.map((a) => a.id)).toContain(account.id);
  });

  it('refuses a savings deposit onto another collector’s customer', async () => {
    const account = await savings.openAccount(
      officer,
      bobCustomer,
      undefined,
      undefined,
      'cash',
      'standard',
    );
    const accountId = new Types.ObjectId(account.id);

    await expect(
      savings.deposit(alice, accountId, 1_000, randomUUID(), 'cash'),
    ).rejects.toMatchObject({ code: 'CUSTOMER_NOT_ASSIGNED', status: 403 });

    const ok = await savings.deposit(bob, accountId, 1_000, randomUUID(), 'cash');
    expect(ok.txn.amount).toBe(1_000);
  });
});

describe('reassignment', () => {
  let alice: AccessTokenPayload;
  let bob: AccessTokenPayload;

  beforeAll(async () => {
    alice = await makeCollector('Reassign Alice');
    bob = await makeCollector('Reassign Bob');
  });

  it('moves a customer between collectors and flips who may act', async () => {
    const customerId = await makeCustomer(false, new Types.ObjectId(alice.sub));
    await expect(customers.getCustomer(bob, customerId)).rejects.toMatchObject({
      code: 'CUSTOMER_NOT_ASSIGNED',
    });

    await customers.reassignCollector(officer, customerId, {
      collectorId: new Types.ObjectId(bob.sub),
      reason: 'Alice left the zone',
    });

    await expect(customers.getCustomer(bob, customerId)).resolves.toMatchObject({
      assignedCollectorId: bob.sub,
    });
    await expect(customers.getCustomer(alice, customerId)).rejects.toMatchObject({
      code: 'CUSTOMER_NOT_ASSIGNED',
    });
  });

  it('refuses a target who is not an active collector', async () => {
    const customerId = await makeCustomer(false, new Types.ObjectId(alice.sub));
    await expect(
      customers.reassignCollector(officer, customerId, {
        collectorId: new Types.ObjectId(officer.sub), // an admin, not a collector
      }),
    ).rejects.toMatchObject({ code: 'INVALID_COLLECTOR', status: 422 });
  });

  it('hands a whole round over in one transaction', async () => {
    const from = await makeCollector('Leaving Collector');
    const to = await makeCollector('Taking Over');
    const ids = [
      await makeCustomer(false, new Types.ObjectId(from.sub)),
      await makeCustomer(false, new Types.ObjectId(from.sub)),
      await makeCustomer(false, new Types.ObjectId(from.sub)),
    ];

    const result = await customers.bulkReassignCollector(officer, {
      fromCollectorId: new Types.ObjectId(from.sub),
      toCollectorId: new Types.ObjectId(to.sub),
      reason: 'resigned',
    });
    expect(result.reassigned).toBe(3);

    for (const id of ids) {
      await expect(customers.getCustomer(to, id)).resolves.toMatchObject({
        assignedCollectorId: to.sub,
      });
    }
    // Repeat run finds nothing left to move.
    const again = await customers.bulkReassignCollector(officer, {
      fromCollectorId: new Types.ObjectId(from.sub),
      toCollectorId: new Types.ObjectId(to.sub),
    });
    expect(again.reassigned).toBe(0);
  });
});
