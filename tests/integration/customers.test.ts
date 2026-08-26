import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomerModel } from '../../src/models/index.js';
import { createCustomer, updateCustomer } from '../../src/modules/customers/customers.service.js';
import {
  createCustomerBody,
  updateCustomerBody,
} from '../../src/modules/customers/customers.schemas.js';
import { asOfficer, setupDb, teardownDb } from './helpers.js';

const CLOUDINARY = 'https://res.cloudinary.com/demo/image/upload';

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
  beforeAll(setupDb);
  afterAll(teardownDb);

  it('clears an alternate phone and email instead of storing null', async () => {
    const actor = asOfficer();
    const created = await createCustomer(
      actor,
      registration({ altPhone: '0551234567', email: 'ama@example.com' }),
    );
    expect(created.altPhone).toBe('0551234567');

    const updated = await updateCustomer(
      actor,
      new Types.ObjectId(created.id),
      patch({ altPhone: '', email: '' }),
    );
    expect(updated.altPhone).toBeUndefined();
    expect(updated.email).toBeUndefined();

    // The path must be GONE, not present holding null — a stored null would
    // fail the ghanaPhone schema the next time the record is edited.
    const raw = await CustomerModel.collection.findOne({ _id: new Types.ObjectId(created.id) });
    expect(raw).not.toBeNull();
    expect('altPhone' in (raw ?? {})).toBe(false);
    expect('email' in (raw ?? {})).toBe(false);
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
