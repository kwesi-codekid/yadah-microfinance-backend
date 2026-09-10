import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { HpItemModel, SusuDepositModel } from '../../src/models/index.js';
import { ID_DOCUMENT_REQUIRED_MESSAGE } from '../../src/lib/id-document.js';
import * as hp from '../../src/modules/hire-purchase/hp.service.js';
import * as loans from '../../src/modules/loans/loans.service.js';
import * as susu from '../../src/modules/susu/susu.service.js';
import { asOfficer, makeCustomer, makeTeller, setupDb, teardownDb } from './helpers.js';

beforeAll(setupDb);
afterAll(teardownDb);

const officer = asOfficer();

/** Customer with an active susu account and 4 months of backdated history. */
async function makeEligibleCustomer(
  withGhanaCard = false,
  options: { withIdDocument?: boolean } = {},
): Promise<Types.ObjectId> {
  const customerId = await makeCustomer(withGhanaCard, undefined, options);
  const account = await susu.openAccount(officer, customerId, 1_000);
  await susu.recordDeposit(officer, new Types.ObjectId(account.id), 5_000, randomUUID(), 'cash');
  await SusuDepositModel.updateMany(
    { customerId },
    { $set: { createdAt: new Date(Date.now() - 130 * 24 * 60 * 60 * 1000) } },
    { timestamps: false, overwriteImmutable: true },
  );
  return customerId;
}

async function makeItem(stock: number): Promise<Types.ObjectId> {
  const item = await hp.createItem(officer, {
    name: `Test Item ${randomUUID().slice(0, 8)}`,
    quantityInStock: stock,
    costPrice: 100_000,
    sellingPrice: 200_000,
  });
  return new Types.ObjectId(item.id);
}

describe('the ID document gate', () => {
  it('names the missing scans as a reason and refuses to sign', async () => {
    const customerId = await makeEligibleCustomer(false, { withIdDocument: false });
    const summary = await hp.hpEligibility(customerId);
    expect(summary.hasIdDocument).toBe(false);
    expect(summary.eligible).toBe(false);
    expect(summary.reasons).toEqual([ID_DOCUMENT_REQUIRED_MESSAGE]);

    const itemId = await makeItem(1);
    await expect(
      hp.createAgreement(officer, { customerId, itemId, durationMonths: 3 }),
    ).rejects.toMatchObject({
      code: 'NOT_ELIGIBLE',
      details: { reasons: [ID_DOCUMENT_REQUIRED_MESSAGE] },
    });
    // The unit was never taken off the shelf.
    expect((await HpItemModel.findById(itemId))?.quantityInStock).toBe(1);
  });
});

/**
 * A teller may sign an agreement at the counter, but it does not stand until a
 * manager says so (client decision, 10 Sep 2026). The unit is reserved either
 * way, so the shelf cannot be sold twice while approval is pending.
 */
describe('an agreement signed at the counter', () => {
  it('waits on a manager, and takes no deposit until it has one', async () => {
    const teller = await makeTeller();
    const customerId = await makeEligibleCustomer();
    const itemId = await makeItem(1);

    const signed = await hp.createAgreement(teller, { customerId, itemId, durationMonths: 6 });
    expect(signed.status).toBe('awaiting-approval');
    // Reserved at signing, exactly as an office-signed one is.
    expect((await HpItemModel.findById(itemId))?.quantityInStock).toBe(0);

    const agreementId = new Types.ObjectId(signed.id);
    await expect(
      hp.recordDeposit(teller, agreementId, signed.depositRequired, randomUUID(), 'cash'),
    ).rejects.toMatchObject({ code: 'NOT_APPROVED' });

    const approved = await hp.approveAgreement(officer, agreementId);
    expect(approved.status).toBe('pending');

    const paid = await hp.recordDeposit(
      teller,
      agreementId,
      signed.depositRequired,
      randomUUID(),
      'cash',
    );
    expect(paid.agreement.status).toBe('active');
  });

  it('stands at once when the office signs it — they are the approver', async () => {
    const customerId = await makeEligibleCustomer();
    const itemId = await makeItem(1);
    const signed = await hp.createAgreement(officer, { customerId, itemId, durationMonths: 6 });
    expect(signed.status).toBe('pending');
  });

  it('can be turned down while it is still waiting, and the unit goes back', async () => {
    const teller = await makeTeller();
    const customerId = await makeEligibleCustomer();
    const itemId = await makeItem(1);

    const signed = await hp.createAgreement(teller, { customerId, itemId, durationMonths: 3 });
    await hp.rejectAgreement(officer, new Types.ObjectId(signed.id), 'changed their mind');
    expect((await HpItemModel.findById(itemId))?.quantityInStock).toBe(1);
  });

  it('refuses a second approval', async () => {
    const teller = await makeTeller();
    const customerId = await makeEligibleCustomer();
    const itemId = await makeItem(1);
    const signed = await hp.createAgreement(teller, { customerId, itemId, durationMonths: 3 });
    const id = new Types.ObjectId(signed.id);
    await hp.approveAgreement(officer, id);
    await expect(hp.approveAgreement(officer, id)).rejects.toMatchObject({
      code: 'NOT_AWAITING_APPROVAL',
    });
  });
});

describe('hire purchase transactions (Stage A)', () => {
  it('two customers racing for the last unit: exactly one agreement signs', async () => {
    const [c1, c2] = await Promise.all([makeEligibleCustomer(), makeEligibleCustomer()]);
    const itemId = await makeItem(1);

    const results = await Promise.allSettled([
      hp.createAgreement(officer, { customerId: c1, itemId, durationMonths: 6 }),
      hp.createAgreement(officer, { customerId: c2, itemId, durationMonths: 6 }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBe(1);
    const item = await HpItemModel.findById(itemId);
    expect(item?.quantityInStock).toBe(0);
  });

  it('rejecting a pending agreement restores stock', async () => {
    const customerId = await makeEligibleCustomer();
    const itemId = await makeItem(1);
    const agreement = await hp.createAgreement(officer, { customerId, itemId, durationMonths: 3 });
    expect((await HpItemModel.findById(itemId))?.quantityInStock).toBe(0);

    await hp.rejectAgreement(officer, new Types.ObjectId(agreement.id), 'changed mind');
    expect((await HpItemModel.findById(itemId))?.quantityInStock).toBe(1);
  });

  it('parallel deposits under one idempotency key record exactly once', async () => {
    const customerId = await makeEligibleCustomer();
    const itemId = await makeItem(1);
    const agreement = await hp.createAgreement(officer, { customerId, itemId, durationMonths: 3 });
    const agreementId = new Types.ObjectId(agreement.id);
    const key = randomUUID();

    const results = await Promise.allSettled([
      hp.recordDeposit(officer, agreementId, 100_000, key, 'cash'),
      hp.recordDeposit(officer, agreementId, 100_000, key, 'cash'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    const detail = await hp.getAgreement(agreementId);
    expect(detail.agreement.status).toBe('active');
    expect(detail.agreement.totalPaid).toBe(100_000); // once, not twice
    expect(detail.payments).toHaveLength(1);
  });

  it('loans and HP block each other in both directions', async () => {
    const customerId = await makeEligibleCustomer(true); // ghana card for the loan side
    const itemId = await makeItem(2);

    // HP open → loan refused
    const agreement = await hp.createAgreement(officer, { customerId, itemId, durationMonths: 3 });
    await expect(loans.applyForLoan(officer, customerId, 100_000, 3)).rejects.toMatchObject({
      code: 'HP_EXISTS',
    });

    // Close the HP (reject), take a loan → HP refused
    await hp.rejectAgreement(officer, new Types.ObjectId(agreement.id), 'test');
    await loans.applyForLoan(officer, customerId, 100_000, 3);
    await expect(
      hp.createAgreement(officer, { customerId, itemId, durationMonths: 3 }),
    ).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
  });
});
