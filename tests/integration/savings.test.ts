import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { SavingsAccountModel, SavingsTxnModel } from '../../src/models/index.js';
import { MIN_BALANCE, WITHDRAWAL_FEE } from '../../src/domain/savings.js';
import * as savings from '../../src/modules/savings/savings.service.js';
import { asOfficer, makeCustomer, setupDb, teardownDb } from './helpers.js';

beforeAll(setupDb);
afterAll(teardownDb);

const officer = asOfficer();

describe('savings withdrawal race (WBS 7.2)', () => {
  it('parallel withdrawals: exactly one lands, balance consistent', async () => {
    const customerId = await makeCustomer();
    const opened = await savings.openAccount(officer, customerId, 50_000, randomUUID(), 'cash');
    const accountId = new Types.ObjectId(opened.account.id);

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => savings.withdraw(officer, accountId, 1_000, randomUUID())),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBe(1);

    const account = await SavingsAccountModel.findById(accountId);
    expect(account?.balance).toBe(50_000 - 2_000); // amount + fee, once
    expect(await SavingsTxnModel.countDocuments({ accountId, type: 'withdrawal' })).toBe(1);
  });

  it('withdrawal never breaches the minimum balance', async () => {
    const customerId = await makeCustomer();
    const opened = await savings.openAccount(officer, customerId, 10_000, randomUUID(), 'cash');
    const accountId = new Types.ObjectId(opened.account.id);

    // Derived from the constants, not written out. This test asserted a GHS 50
    // floor for some time after the floor became GHS 10 (2203bce), and went on
    // proving nothing but its own arithmetic.
    const available = 10_000 - MIN_BALANCE - WITHDRAWAL_FEE;

    await expect(
      savings.withdraw(officer, accountId, available + 1, randomUUID()),
    ).rejects.toMatchObject({
      code: 'EXCEEDS_AVAILABLE',
    });

    const result = await savings.withdraw(officer, accountId, available, randomUUID());
    expect(result.account.balance).toBe(MIN_BALANCE); // lands exactly on the floor
  });
});
