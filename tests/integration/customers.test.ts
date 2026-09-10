import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomerModel, SusuDepositModel } from '../../src/models/index.js';
import { createCustomer, updateCustomer } from '../../src/modules/customers/customers.service.js';
import {
  createCustomerBody,
  updateCustomerBody,
} from '../../src/modules/customers/customers.schemas.js';
import * as hp from '../../src/modules/hire-purchase/hp.service.js';
import * as loans from '../../src/modules/loans/loans.service.js';
import * as susu from '../../src/modules/susu/susu.service.js';
import { CLOUDINARY, asOfficer, makeCollector, setupDb, teardownDb } from './helpers.js';

/** Every registration joins a collector's round; one is made for the file. */
let collectorId: string;
async function setup(): Promise<void> {
  await setupDb();
  collectorId = (await makeCollector()).sub;
}
beforeAll(setup);
afterAll(teardownDb);

/** Bodies go through the real schema — clearing is a parse-level concern. */
function parseWith<T>(schema: { safeParse: (v: unknown) => unknown }, input: unknown): T {
  const parsed = schema.safeParse(input) as
    { success: true; data: T } | { success: false; error: { issues: unknown } };
  if (!parsed.success) throw new Error(`rejected: ${JSON.stringify(parsed.error.issues)}`);
  return parsed.data;
}

let seq = 0;
function registration(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return parseWith<Parameters<typeof createCustomer>[1]>(createCustomerBody, {
    fullName: `Edit Test ${String(seq)}`,
    phone: `0244${String(100000 + seq)}`,
    assignedCollectorId: collectorId,
    photoUrl: `${CLOUDINARY}/photo.jpg`,
    idDocumentFrontUrl: `${CLOUDINARY}/front.jpg`,
    idDocumentBackUrl: `${CLOUDINARY}/back.jpg`,
    ...overrides,
  });
}

function patch(input: Record<string, unknown>) {
  return parseWith<Parameters<typeof updateCustomer>[2]>(updateCustomerBody, input);
}

describe('editing a customer', () => {
  it('clears an alternate phone and an occupation instead of storing null', async () => {
    const actor = asOfficer();
    const created = await createCustomer(
      actor,
      registration({ altPhone: '0551234567', occupation: 'Trader' }),
    );
    expect(created.altPhone).toBe('0551234567');

    const updated = await updateCustomer(
      actor,
      new Types.ObjectId(created.id),
      patch({ altPhone: '', occupation: '' }),
    );
    expect(updated.altPhone).toBeUndefined();
    expect(updated.occupation).toBeUndefined();

    // The path must be GONE, not present holding null — a stored null would
    // fail the ghanaPhone schema the next time the record is edited.
    const raw = await CustomerModel.collection.findOne({ _id: new Types.ObjectId(created.id) });
    expect(raw).not.toBeNull();
    expect('altPhone' in (raw ?? {})).toBe(false);
    expect('occupation' in (raw ?? {})).toBe(false);
  });

  it('clears a whole next-of-kin block', async () => {
    const actor = asOfficer();
    const created = await createCustomer(
      actor,
      registration({ nextOfKin: { fullName: 'Kofi Mensah', phone: '0209876543' } }),
    );
    expect(created.nextOfKin?.fullName).toBe('Kofi Mensah');

    const updated = await updateCustomer(
      actor,
      new Types.ObjectId(created.id),
      patch({ nextOfKin: null }),
    );
    expect(updated.nextOfKin).toBeUndefined();

    const raw = await CustomerModel.collection.findOne({ _id: new Types.ObjectId(created.id) });
    expect('nextOfKin' in (raw ?? {})).toBe(false);
  });

  it('stores a +233 number in canonical local form', async () => {
    const actor = asOfficer();
    const created = await createCustomer(actor, registration());
    const updated = await updateCustomer(
      actor,
      new Types.ObjectId(created.id),
      patch({ altPhone: '+233 55 123 4567' }),
    );
    expect(updated.altPhone).toBe('0551234567');
  });

  it('re-checks phone distinctness against stored values a patch cannot see', async () => {
    const actor = asOfficer();
    const created = await createCustomer(actor, registration({ altPhone: '0559998888' }));
    // The patch sets only phone; the clash is with the STORED altPhone.
    await expect(
      updateCustomer(actor, new Types.ObjectId(created.id), patch({ phone: '0559998888' })),
    ).rejects.toMatchObject({ code: 'PHONES_NOT_DISTINCT' });
  });

  it('leaves fields absent from the patch untouched', async () => {
    const actor = asOfficer();
    const created = await createCustomer(
      actor,
      registration({ altPhone: '0551112222', occupation: 'Trader' }),
    );
    const updated = await updateCustomer(
      actor,
      new Types.ObjectId(created.id),
      patch({ occupation: 'Seamstress' }),
    );
    expect(updated.occupation).toBe('Seamstress');
    expect(updated.altPhone).toBe('0551112222');
  });

  it('clearing an already-empty field is a no-op, not a spurious edit', async () => {
    const actor = asOfficer();
    const created = await createCustomer(actor, registration());
    const updated = await updateCustomer(
      actor,
      new Types.ObjectId(created.id),
      patch({ altPhone: '', occupation: 'Trader' }),
    );
    expect(updated.altPhone).toBeUndefined();
    expect(updated.occupation).toBe('Trader');
  });
});

/** A Ghana Card on the profile, unique per customer — loans insist on one. */
function ghanaCard(): { idType: 'ghana-card'; idNumber: string } {
  seq += 1;
  return { idType: 'ghana-card', idNumber: `GHA-${String(900000000 + seq)}-0` };
}

describe('the ID document and open credit', () => {
  const officer = asOfficer();

  it('is optional at registration', async () => {
    const created = await createCustomer(
      officer,
      registration({ idDocumentFrontUrl: '', idDocumentBackUrl: undefined }),
    );
    expect(created.idDocumentFrontUrl).toBeUndefined();
    expect(created.idDocumentBackUrl).toBeUndefined();
    const raw = await CustomerModel.collection.findOne({ _id: new Types.ObjectId(created.id) });
    expect('idDocumentFrontUrl' in (raw ?? {})).toBe(false);
  });

  it('can be removed while the customer holds no loan or hire purchase', async () => {
    const created = await createCustomer(officer, registration());
    const updated = await updateCustomer(
      officer,
      new Types.ObjectId(created.id),
      patch({ idDocumentFrontUrl: '', idDocumentBackUrl: null }),
    );
    expect(updated.idDocumentFrontUrl).toBeUndefined();
    expect(updated.idDocumentBackUrl).toBeUndefined();
  });

  it('stays on file while a loan is open — replaceable, never removable', async () => {
    const created = await createCustomer(officer, registration({ identification: ghanaCard() }));
    const customerId = new Types.ObjectId(created.id);
    const loan = await loans.applyForLoan(officer, customerId, 100_000, 3);

    await expect(
      updateCustomer(officer, customerId, patch({ idDocumentBackUrl: '' })),
    ).rejects.toMatchObject({
      code: 'ID_DOCUMENT_IN_USE',
      details: { loans: 1, hirePurchase: 0 },
    });

    // A fresh scan of the same document keeps the ID on file, so it is allowed.
    const replaced = await updateCustomer(
      officer,
      customerId,
      patch({ idDocumentBackUrl: `${CLOUDINARY}/back-2.jpg` }),
    );
    expect(replaced.idDocumentBackUrl).toBe(`${CLOUDINARY}/back-2.jpg`);

    // Once the loan is closed the profile is free again.
    await loans.rejectLoan(officer, new Types.ObjectId(loan.id), 'test');
    const cleared = await updateCustomer(officer, customerId, patch({ idDocumentBackUrl: '' }));
    expect(cleared.idDocumentBackUrl).toBeUndefined();
  });

  it('stays on file while a hire-purchase agreement is open', async () => {
    const created = await createCustomer(officer, registration());
    const customerId = new Types.ObjectId(created.id);
    // Eligible for HP: an active susu account with four months of history.
    const account = await susu.openAccount(officer, customerId, 1_000);
    await susu.recordDeposit(officer, new Types.ObjectId(account.id), 5_000, randomUUID(), 'cash');
    await SusuDepositModel.updateMany(
      { customerId },
      { $set: { createdAt: new Date(Date.now() - 130 * 24 * 60 * 60 * 1000) } },
      { timestamps: false, overwriteImmutable: true },
    );
    const item = await hp.createItem(officer, {
      name: `ID Test Item ${randomUUID().slice(0, 8)}`,
      quantityInStock: 1,
      costPrice: 100_000,
      sellingPrice: 200_000,
    });
    await hp.createAgreement(officer, {
      customerId,
      itemId: new Types.ObjectId(item.id),
      durationMonths: 3,
    });

    await expect(
      updateCustomer(officer, customerId, patch({ idDocumentFrontUrl: null })),
    ).rejects.toMatchObject({
      code: 'ID_DOCUMENT_IN_USE',
      details: { loans: 0, hirePurchase: 1 },
    });
  });
});
