import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SusuAccountModel, SusuDepositModel } from '../../src/models/index.js';
import * as susu from '../../src/modules/susu/susu.service.js';
import { asOfficer, makeCustomer, setupDb, teardownDb } from './helpers.js';

beforeAll(setupDb);
afterAll(teardownDb);

const officer = asOfficer();

describe('susu transactions (WBS 7.2)', () => {
  it('collect-all is all-or-nothing: wrong amount writes nothing', async () => {
    const customerId = await makeCustomer();
    await susu.openAccount(officer, customerId, 2_000);
    await susu.openAccount(officer, customerId, 1_000);

    await expect(
      susu.collectAll(officer, customerId, 5_000, randomUUID(), 'cash'),
    ).rejects.toMatchObject({ code: 'AMOUNT_MISMATCH' });

    expect(await SusuDepositModel.countDocuments({ customerId })).toBe(0);
    const accounts = await SusuAccountModel.find({ customerId });
    expect(accounts.every((a) => a.depositsCount === 0)).toBe(true);
  });

  it('collect-all with the exact amount writes one deposit per account atomically', async () => {
    const customerId = await makeCustomer();
    await susu.openAccount(officer, customerId, 2_000);
    await susu.openAccount(officer, customerId, 1_000);

    const result = await susu.collectAll(officer, customerId, 3_000, randomUUID(), 'cash');
    expect(result.deposits).toHaveLength(2);
    expect(result.totalAmount).toBe(3_000);
    const accounts = await SusuAccountModel.find({ customerId });
    expect(accounts.every((a) => a.depositsCount === 1)).toBe(true);
  });

  it('collect-all replay returns the original batch without new writes', async () => {
    const customerId = await makeCustomer();
    await susu.openAccount(officer, customerId, 1_000);
    const key = randomUUID();
    await susu.collectAll(officer, customerId, 1_000, key, 'cash');
    const replay = await susu.collectAll(officer, customerId, 1_000, key, 'cash');
    expect(replay.replayed).toBe(true);
    expect(await SusuDepositModel.countDocuments({ customerId })).toBe(1);
  });

  it('concurrent deposits on one account never lose updates', async () => {
    const customerId = await makeCustomer();
    const account = await susu.openAccount(officer, customerId, 1_000);
    const accountId = new (await import('mongoose')).Types.ObjectId(account.id);

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        susu.recordDeposit(officer, accountId, 1, randomUUID(), 'cash'),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const after = await SusuAccountModel.findById(accountId);
    expect(after?.depositsCount).toBe(ok);
    expect(after?.totalDeposited).toBe(ok * 1_000);
    expect(await SusuDepositModel.countDocuments({ accountId })).toBe(ok);
  });

  it('deposit replay under the same idempotency key records exactly once', async () => {
    const customerId = await makeCustomer();
    const account = await susu.openAccount(officer, customerId, 1_000);
    const accountId = new (await import('mongoose')).Types.ObjectId(account.id);
    const key = randomUUID();

    const first = await susu.recordDeposit(officer, accountId, 2, key, 'cash');
    const second = await susu.recordDeposit(officer, accountId, 2, key, 'cash');
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.deposit.id).toBe(first.deposit.id);
    const after = await SusuAccountModel.findById(accountId);
    expect(after?.depositsCount).toBe(2);
  });
});
