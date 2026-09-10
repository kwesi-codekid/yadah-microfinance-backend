import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { env } from '../../src/config/env.js';
import { verifyWebhookSignature } from '../../src/lib/paystack.js';
import { PaystackChargeModel, SusuDepositModel } from '../../src/models/index.js';
import * as payments from '../../src/modules/payments/payments.service.js';
import * as susu from '../../src/modules/susu/susu.service.js';
import { asOfficer, makeCustomer, setupDb, teardownDb } from './helpers.js';

beforeAll(setupDb);
afterAll(teardownDb);
afterEach(() => {
  vi.unstubAllGlobals();
  env.PAYSTACK_SECRET_KEY = '';
});

const officer = asOfficer();
const SECRET = 'sk_test_integration';

function stubPaystackFetch(status = 'pay_offline'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            status: true,
            data: { status, display_text: 'Approve on your phone' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    ),
  );
}

async function initiateSusuCharge(): Promise<{
  accountId: Types.ObjectId;
  reference: string;
}> {
  env.PAYSTACK_SECRET_KEY = SECRET;
  stubPaystackFetch();
  const customerId = await makeCustomer();
  const account = await susu.openAccount(officer, customerId, 1_000);
  const accountId = new Types.ObjectId(account.id);
  const charge = await payments.initiateCharge(officer, {
    kind: 'susu-deposit',
    targetId: accountId,
    amount: 2_000,
    phone: '0594213496',
    provider: 'mtn',
  });
  return { accountId, reference: charge.reference };
}

describe('paystack charges', () => {
  it('answers 503 when the secret key is not configured', async () => {
    const customerId = await makeCustomer();
    const account = await susu.openAccount(officer, customerId, 1_000);
    await expect(
      payments.initiateCharge(officer, {
        kind: 'susu-deposit',
        targetId: new Types.ObjectId(account.id),
        amount: 1_000,
        phone: '0594213496',
        provider: 'mtn',
      }),
    ).rejects.toMatchObject({ code: 'PAYMENTS_NOT_CONFIGURED', status: 503 });
  });

  it('validates the target before any money moves', async () => {
    env.PAYSTACK_SECRET_KEY = SECRET;
    stubPaystackFetch();
    const customerId = await makeCustomer();
    const account = await susu.openAccount(officer, customerId, 1_000);
    await expect(
      payments.initiateCharge(officer, {
        kind: 'susu-deposit',
        targetId: new Types.ObjectId(account.id),
        amount: 1_500, // not a multiple of the daily amount
        phone: '0594213496',
        provider: 'mtn',
      }),
    ).rejects.toMatchObject({ code: 'AMOUNT_MISMATCH' });
    expect(await PaystackChargeModel.countDocuments({ customerId })).toBe(0);
  });

  it('charge.success applies the deposit through the normal idempotent path', async () => {
    const { accountId, reference } = await initiateSusuCharge();

    const result = await payments.handleWebhookEvent({
      event: 'charge.success',
      data: { reference, amount: 2_000, currency: 'GHS', status: 'success' },
    });
    expect(result.handled).toBe(true);

    const charge = await payments.getCharge(officer, reference);
    expect(charge.status).toBe('success');
    expect(charge.executionStatus).toBe('applied');

    const deposit = await SusuDepositModel.findOne({ accountId });
    expect(deposit).toMatchObject({
      amount: 2_000,
      daysCovered: 2,
      channel: 'paystack',
      idempotencyKey: `paystack:${reference}`,
    });

    // Duplicate delivery: no double-record.
    await payments.handleWebhookEvent({
      event: 'charge.success',
      data: { reference, amount: 2_000, currency: 'GHS', status: 'success' },
    });
    expect(await SusuDepositModel.countDocuments({ accountId })).toBe(1);
  });

  it('flags an amount mismatch instead of applying it', async () => {
    const { accountId, reference } = await initiateSusuCharge();

    await payments.handleWebhookEvent({
      event: 'charge.success',
      data: { reference, amount: 1_000, currency: 'GHS', status: 'success' },
    });
    const charge = await payments.getCharge(officer, reference);
    expect(charge.executionStatus).toBe('failed');
    expect(await SusuDepositModel.countDocuments({ accountId })).toBe(0);
  });

  it('holds a paid charge whose target state changed (success but not applied)', async () => {
    const { accountId, reference } = await initiateSusuCharge();
    await susu.terminateAccount(officer, accountId); // empty account, terminable

    await payments.handleWebhookEvent({
      event: 'charge.success',
      data: { reference, amount: 2_000, currency: 'GHS', status: 'success' },
    });
    const charge = await payments.getCharge(officer, reference);
    expect(charge.status).toBe('success');
    expect(charge.executionStatus).toBe('failed');
    expect(charge.failureReason).toContain('ACCOUNT_NOT_ACTIVE');
  });

  it('ignores unknown references', async () => {
    const result = await payments.handleWebhookEvent({
      event: 'charge.success',
      data: { reference: `yadah-${randomUUID()}`, amount: 1, currency: 'GHS' },
    });
    expect(result.handled).toBe(false);
  });
});

describe('webhook signature', () => {
  it('accepts only a correct HMAC-SHA512 over the exact bytes', () => {
    env.PAYSTACK_SECRET_KEY = SECRET;
    const body = Buffer.from(JSON.stringify({ event: 'charge.success' }));
    const good = createHmac('sha512', SECRET).update(body).digest('hex');

    expect(verifyWebhookSignature(body, good)).toBe(true);
    expect(verifyWebhookSignature(body, good.replace(/^./, '0'))).toBe(false);
    expect(verifyWebhookSignature(Buffer.from('tampered'), good)).toBe(false);
    expect(verifyWebhookSignature(body, undefined)).toBe(false);
  });
});
