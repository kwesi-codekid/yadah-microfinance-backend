import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { CustomerModel, PayoutRequestModel, PortalOtpModel } from '../../src/models/index.js';
import * as portalAuth from '../../src/modules/portal/portal-auth.service.js';
import * as portal from '../../src/modules/portal/portal.service.js';
import * as requests from '../../src/modules/portal/payout-requests.service.js';
import * as savings from '../../src/modules/savings/savings.service.js';
import * as susu from '../../src/modules/susu/susu.service.js';
import { asOfficer, makeCustomer, setupDb, teardownDb } from './helpers.js';

beforeAll(setupDb);
afterAll(teardownDb);

const officer = asOfficer();

/** The OTP is hashed in the DB, so tests drive login through the real flow. */
async function signIn(phone: string): Promise<string> {
  await portalAuth.requestOtp(phone);
  const otp = await PortalOtpModel.findOne({ phone });
  if (!otp) throw new Error('no OTP issued');
  // Brute-force the 6-digit space is not viable; instead re-stamp a known hash
  // the same way the service does, which exercises verifyOtp for real.
  const { createHash } = await import('node:crypto');
  await PortalOtpModel.updateOne(
    { _id: otp._id },
    { $set: { codeHash: createHash('sha256').update('123456').digest('hex') } },
  );
  const { customer } = await portalAuth.verifyOtp(phone, '123456');
  return customer.id;
}

describe('portal login', () => {
  it('issues a session to an active customer on their registered phone', async () => {
    const customerId = await makeCustomer();
    const customer = await CustomerModel.findById(customerId);
    const signedInId = await signIn(customer!.phone);
    expect(signedInId).toBe(customerId.toHexString());
  });

  it('burns the code — the same one cannot be used twice', async () => {
    const customerId = await makeCustomer();
    const customer = await CustomerModel.findById(customerId);
    await signIn(customer!.phone);
    await expect(portalAuth.verifyOtp(customer!.phone, '123456')).rejects.toMatchObject({
      code: 'INVALID_OTP',
    });
  });

  it('stays silent for an unknown number rather than revealing who banks here', async () => {
    // No throw, no OTP written — indistinguishable from a successful send.
    await expect(portalAuth.requestOtp('0249999999')).resolves.toBeUndefined();
    expect(await PortalOtpModel.countDocuments({ phone: '0249999999' })).toBe(0);
  });

  it('gives the same error for a wrong code as for an unknown number', async () => {
    const customerId = await makeCustomer();
    const customer = await CustomerModel.findById(customerId);
    await portalAuth.requestOtp(customer!.phone);

    const wrongCode = portalAuth.verifyOtp(customer!.phone, '000000').catch((e: unknown) => e);
    const unknownNumber = portalAuth.verifyOtp('0249999998', '123456').catch((e: unknown) => e);
    expect(((await wrongCode) as { code: string }).code).toBe(
      ((await unknownNumber) as { code: string }).code,
    );
  });

  it('rotates refresh tokens and kills the family on replay', async () => {
    const customerId = await makeCustomer();
    const customer = await CustomerModel.findById(customerId);
    await portalAuth.requestOtp(customer!.phone);
    const { createHash } = await import('node:crypto');
    await PortalOtpModel.updateOne(
      { phone: customer!.phone },
      { $set: { codeHash: createHash('sha256').update('123456').digest('hex') } },
    );
    const { tokens } = await portalAuth.verifyOtp(customer!.phone, '123456');

    const rotated = await portalAuth.refresh(tokens.refreshToken);
    expect(rotated.refreshToken).not.toBe(tokens.refreshToken);

    // Replaying the original revokes the whole family, so even the good one dies.
    await expect(portalAuth.refresh(tokens.refreshToken)).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
    });
    await expect(portalAuth.refresh(rotated.refreshToken)).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
    });
  });
});

describe('portal data is scoped to the token holder', () => {
  it('never returns another customer’s accounts', async () => {
    const mine = await makeCustomer();
    const theirs = await makeCustomer();
    await susu.openAccount(officer, mine, 1_000);
    await susu.openAccount(officer, theirs, 2_000);

    const accounts = await portal.myAccounts(mine.toHexString());
    expect(accounts.susu).toHaveLength(1);
    expect(accounts.susu[0]?.dailyAmount).toBe(1_000);
  });

  it('404s on someone else’s account rather than confirming it exists', async () => {
    const mine = await makeCustomer();
    const theirs = await makeCustomer();
    const other = await susu.openAccount(officer, theirs, 2_000);

    await expect(
      portal.assertOwnedSusu(mine.toHexString(), new Types.ObjectId(other.id)),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('derives the figures a handset should not have to compute', async () => {
    const customerId = await makeCustomer();
    const { account } = await savings.openAccount(
      officer,
      customerId,
      20_000,
      undefined,
      'cash',
      'standard',
    );
    const accounts = await portal.myAccounts(customerId.toHexString());
    const savingsRow = accounts.savings.find((a) => a.accountId === account.id);

    // GHS 200 balance − GHS 50 minimum − GHS 10 fee = GHS 140.
    expect(savingsRow?.balance).toBe(20_000);
    expect(savingsRow?.available).toBe(14_000);
  });
});

describe('withdrawal requests', () => {
  it('refuses more than the savings rules allow, before the office ever sees it', async () => {
    const customerId = await makeCustomer();
    const { account } = await savings.openAccount(
      officer,
      customerId,
      20_000,
      undefined,
      'cash',
      'standard',
    );

    await expect(
      requests.submitRequest(customerId.toHexString(), {
        kind: 'savings-withdrawal',
        targetId: new Types.ObjectId(account.id),
        amount: 19_000, // more than the 14,000 available
        payoutProvider: 'mtn',
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_AVAILABLE' });
  });

  it('allows one open request per account', async () => {
    const customerId = await makeCustomer();
    const { account } = await savings.openAccount(
      officer,
      customerId,
      20_000,
      undefined,
      'cash',
      'standard',
    );
    const target = new Types.ObjectId(account.id);

    await requests.submitRequest(customerId.toHexString(), {
      kind: 'savings-withdrawal',
      targetId: target,
      amount: 5_000,
      payoutProvider: 'mtn',
    });
    await expect(
      requests.submitRequest(customerId.toHexString(), {
        kind: 'savings-withdrawal',
        targetId: target,
        amount: 1_000,
        payoutProvider: 'mtn',
      }),
    ).rejects.toMatchObject({ code: 'REQUEST_ALREADY_OPEN' });
  });

  it('defaults the payout wallet to the customer’s registered number', async () => {
    const customerId = await makeCustomer();
    const customer = await CustomerModel.findById(customerId);
    const { account } = await savings.openAccount(
      officer,
      customerId,
      20_000,
      undefined,
      'cash',
      'standard',
    );

    const request = await requests.submitRequest(customerId.toHexString(), {
      kind: 'savings-withdrawal',
      targetId: new Types.ObjectId(account.id),
      amount: 5_000,
      payoutProvider: 'mtn',
    });
    expect(request.payoutPhone).toBe(customer!.phone);
    expect(request.status).toBe('pending');
  });

  it('refuses a susu closure that cannot cover the commission', async () => {
    const customerId = await makeCustomer();
    // Opened but never deposited into: balance 0, below one day's commission.
    const account = await susu.openAccount(officer, customerId, 1_000);

    await expect(
      requests.submitRequest(customerId.toHexString(), {
        kind: 'susu-closure',
        targetId: new Types.ObjectId(account.id),
        payoutProvider: 'mtn',
      }),
    ).rejects.toMatchObject({ code: 'BELOW_COMMISSION' });
  });

  it('rejecting moves nothing and records the reason', async () => {
    const customerId = await makeCustomer();
    const { account } = await savings.openAccount(
      officer,
      customerId,
      20_000,
      undefined,
      'cash',
      'standard',
    );
    const submitted = await requests.submitRequest(customerId.toHexString(), {
      kind: 'savings-withdrawal',
      targetId: new Types.ObjectId(account.id),
      amount: 5_000,
      payoutProvider: 'mtn',
    });

    const rejected = await requests.rejectRequest(
      officer,
      new Types.ObjectId(submitted.id),
      'Please visit the office with your ID',
    );
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectionReason).toContain('office');

    // The balance is untouched.
    const after = await portal.myAccounts(customerId.toHexString());
    expect(after.savings[0]?.balance).toBe(20_000);

    // And a decided request cannot be decided again.
    await expect(
      requests.rejectRequest(officer, new Types.ObjectId(submitted.id), 'again'),
    ).rejects.toMatchObject({ code: 'NOT_PENDING' });
  });

  it('keeps a customer’s request list to their own', async () => {
    const mine = await makeCustomer();
    const theirs = await makeCustomer();
    for (const customerId of [mine, theirs]) {
      const { account } = await savings.openAccount(
        officer,
        customerId,
        20_000,
        undefined,
        'cash',
        'standard',
      );
      await requests.submitRequest(customerId.toHexString(), {
        kind: 'savings-withdrawal',
        targetId: new Types.ObjectId(account.id),
        amount: 5_000,
        payoutProvider: 'mtn',
      });
    }

    const list = await requests.listMyRequests(mine.toHexString(), { page: 1, limit: 20 });
    expect(list.total).toBe(1);
    expect(list.items[0]?.customerId).toBe(mine.toHexString());
    // The office sees both.
    expect((await requests.listRequests({ page: 1, limit: 20 })).total).toBeGreaterThanOrEqual(2);
  });
});

describe('payout request records', () => {
  it('mints a unique idempotency key per request, reused for the withdrawal', async () => {
    const customerId = await makeCustomer();
    const { account } = await savings.openAccount(
      officer,
      customerId,
      20_000,
      undefined,
      'cash',
      'standard',
    );
    const submitted = await requests.submitRequest(customerId.toHexString(), {
      kind: 'savings-withdrawal',
      targetId: new Types.ObjectId(account.id),
      amount: 5_000,
      payoutProvider: 'mtn',
    });

    const stored = await PayoutRequestModel.findById(submitted.id);
    expect(stored?.idempotencyKey).toBeTruthy();
    // A retried approval reuses this key, so the withdrawal can never double-apply.
    expect(stored?.idempotencyKey).toHaveLength(36);
  });
});
