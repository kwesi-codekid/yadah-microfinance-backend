import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { SusuAccountModel, SusuDepositModel, SusuPayoutModel } from '../../src/models/index.js';
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
        susu.recordDeposit(officer, accountId, 1_000, randomUUID(), 'cash'),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const after = await SusuAccountModel.findById(accountId);
    expect(after?.depositsCount).toBe(ok);
    expect(after?.totalDeposited).toBe(ok * 1_000);
    expect(await SusuDepositModel.countDocuments({ accountId })).toBe(ok);
  });

  it('rejects a deposit that is not a multiple of the daily amount', async () => {
    const customerId = await makeCustomer();
    const account = await susu.openAccount(officer, customerId, 1_000);
    const accountId = new Types.ObjectId(account.id);

    await expect(
      susu.recordDeposit(officer, accountId, 1_500, randomUUID(), 'cash'),
    ).rejects.toMatchObject({ code: 'AMOUNT_MISMATCH' });
    expect(await SusuDepositModel.countDocuments({ accountId })).toBe(0);
  });

  it('deposit replay under the same idempotency key records exactly once', async () => {
    const customerId = await makeCustomer();
    const account = await susu.openAccount(officer, customerId, 1_000);
    const accountId = new (await import('mongoose')).Types.ObjectId(account.id);
    const key = randomUUID();

    const first = await susu.recordDeposit(officer, accountId, 2_000, key, 'cash');
    const second = await susu.recordDeposit(officer, accountId, 2_000, key, 'cash');
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.deposit.id).toBe(first.deposit.id);
    const after = await SusuAccountModel.findById(accountId);
    expect(after?.depositsCount).toBe(2);
  });
});

describe('susu closure', () => {
  it('refuses to close an account whose deposits cannot cover the commission', async () => {
    const customerId = await makeCustomer();
    const account = await susu.openAccount(officer, customerId, 1_000);
    const accountId = new Types.ObjectId(account.id);

    await expect(susu.closeAccount(officer, accountId)).rejects.toMatchObject({
      code: 'COMMISSION_NOT_COVERED',
    });
    const after = await SusuAccountModel.findById(accountId);
    expect(after?.status).toBe('active');
  });

  it('close records the cash disbursement as a payout row', async () => {
    const customerId = await makeCustomer();
    const account = await susu.openAccount(officer, customerId, 1_000);
    const accountId = new Types.ObjectId(account.id);
    await susu.recordDeposit(officer, accountId, 3_000, randomUUID(), 'cash');

    const result = await susu.closeAccount(officer, accountId);
    expect(result.commission).toBe(1_000);
    expect(result.payout).toBe(2_000);

    const payoutRows = await SusuPayoutModel.find({ accountId });
    expect(payoutRows).toHaveLength(1);
    expect(payoutRows[0]).toMatchObject({ amount: 2_000, destination: 'cash' });
  });
});

describe('susu termination', () => {
  it('terminates an empty account with no commission and no payout row', async () => {
    const customerId = await makeCustomer();
    const account = await susu.openAccount(officer, customerId, 1_000);
    const accountId = new Types.ObjectId(account.id);

    const result = await susu.terminateAccount(officer, accountId);
    expect(result.refund).toBe(0);
    expect(result.account.status).toBe('terminated');

    const after = await SusuAccountModel.findById(accountId);
    expect(after?.commissionAmount).toBe(0);
    expect(await SusuPayoutModel.countDocuments({ accountId })).toBe(0);
  });

  it('refuses to terminate an account that can cover the commission', async () => {
    const customerId = await makeCustomer();
    const account = await susu.openAccount(officer, customerId, 1_000);
    const accountId = new Types.ObjectId(account.id);
    await susu.recordDeposit(officer, accountId, 1_000, randomUUID(), 'cash');

    await expect(susu.terminateAccount(officer, accountId)).rejects.toMatchObject({
      code: 'CANNOT_TERMINATE',
    });
  });

  it('repeat termination reports the account as closed', async () => {
    const customerId = await makeCustomer();
    const account = await susu.openAccount(officer, customerId, 1_000);
    const accountId = new Types.ObjectId(account.id);
    await susu.terminateAccount(officer, accountId);

    await expect(susu.terminateAccount(officer, accountId)).rejects.toMatchObject({
      code: 'ALREADY_CLOSED',
    });
    await expect(susu.closeAccount(officer, accountId)).rejects.toMatchObject({
      code: 'ALREADY_CLOSED',
    });
  });
});
