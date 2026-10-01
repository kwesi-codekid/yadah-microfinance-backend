import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { AuditLogModel, SavingsAccountModel, SavingsTxnModel } from '../../src/models/index.js';
import { accountPeriodKey } from '../../src/lib/account-number.js';
import { renumberThisMonth } from '../../src/modules/savings/savings.renumber.js';
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

describe('renumbering an account by hand (stop-gap, 1 Oct 2026)', () => {
  it('changes the number, refuses one already in use, and audits the change', async () => {
    const [a, b] = await Promise.all([makeCustomer(), makeCustomer()]);
    const first = await savings.openAccount(officer, a, undefined, undefined, 'cash', 'standard');
    const second = await savings.openAccount(officer, b, undefined, undefined, 'cash', 'standard');
    const id = new Types.ObjectId(first.account.id);

    const renumbered = await savings.changeAccountNumber(officer, id, 'SV26100361');
    expect(renumbered.accountNumber).toBe('SV26100361');
    expect((await savings.getAccount(officer, id)).accountNumber).toBe('SV26100361');
    expect(
      await AuditLogModel.countDocuments({ action: 'savings.account.renumber', entityId: id }),
    ).toBe(1);

    // Another account's number is refused; a malformed one never reaches the service.
    await expect(
      savings.changeAccountNumber(officer, id, second.account.accountNumber),
    ).rejects.toMatchObject({ code: 'NUMBER_TAKEN', status: 409 });

    // The same number again is a no-op, not an error.
    const again = await savings.changeAccountNumber(officer, id, 'SV26100361');
    expect(again.accountNumber).toBe('SV26100361');
  });
});

describe('renumbering this month’s accounts from the office screen (1 Oct 2026)', () => {
  it('previews without writing, then applies in opening order and audits', async () => {
    const period = accountPeriodKey();
    const last = accountPeriodKey(new Date(Date.now() - 31 * 24 * 60 * 60 * 1000));
    const staff = new Types.ObjectId();
    const raw = async (number: string, daysAgo: number) =>
      SavingsAccountModel.collection.insertOne({
        accountNumber: number,
        customerId: await makeCustomer(),
        balance: 0,
        status: 'active',
        openedById: staff,
        deletedAt: null,
        createdAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
        updatedAt: new Date(),
      });
    // Earlier tests opened accounts this month under the live counter; start clean.
    await SavingsTxnModel.deleteMany({});
    await SavingsAccountModel.deleteMany({});
    await raw(`SV${last}0360`, 35);
    await raw(`SV${period}0001`, 0.02);

    const dry = await renumberThisMonth(officer, false);
    expect(dry.apply).toBe(false);
    expect(dry.changes).toEqual([{ from: `SV${period}0001`, to: `SV${period}0361` }]);
    expect(await SavingsAccountModel.countDocuments({ accountNumber: `SV${period}0001` })).toBe(1);

    const applied = await renumberThisMonth(officer, true);
    expect(applied.changes).toEqual([{ from: `SV${period}0001`, to: `SV${period}0361` }]);
    expect(applied.counter).toBe(361);
    expect(await SavingsAccountModel.countDocuments({ accountNumber: `SV${period}0361` })).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'savings.account.renumber-month' })).toBe(
      1,
    );
  });
});
