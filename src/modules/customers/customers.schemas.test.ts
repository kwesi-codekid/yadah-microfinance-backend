import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCustomerBody, identification, phoneClashes } from './customers.schemas.js';

const validBody = {
  fullName: 'Ama Mensah',
  phone: '0241234567',
  photoUrl: 'https://res.cloudinary.com/demo/image/upload/photo.jpg',
  idDocumentFrontUrl: 'https://res.cloudinary.com/demo/image/upload/front.jpg',
  idDocumentBackUrl: 'https://res.cloudinary.com/demo/image/upload/back.jpg',
};

describe('phoneClashes', () => {
  it('accepts three distinct numbers', () => {
    expect(
      phoneClashes({ phone: '0241234567', altPhone: '0551234567', nextOfKinPhone: '0209876543' }),
    ).toEqual([]);
  });

  it('flags altPhone equal to phone', () => {
    expect(phoneClashes({ phone: '0241234567', altPhone: '0241234567' })).toEqual(['altPhone']);
  });

  it('flags next-of-kin phone equal to phone or altPhone', () => {
    expect(phoneClashes({ phone: '0241234567', nextOfKinPhone: '0241234567' })).toEqual([
      'nextOfKinPhone',
    ]);
    expect(
      phoneClashes({ phone: '0241234567', altPhone: '0551234567', nextOfKinPhone: '0551234567' }),
    ).toEqual(['nextOfKinPhone']);
  });

  it('ignores absent optional phones', () => {
    expect(phoneClashes({ phone: '0241234567' })).toEqual([]);
  });
});

describe('createCustomerBody phone distinctness', () => {
  it('rejects a duplicated alternate phone', () => {
    const result = createCustomerBody.safeParse({ ...validBody, altPhone: validBody.phone });
    expect(result.success).toBe(false);
  });

  it('rejects a next-of-kin phone matching the customer phone', () => {
    const result = createCustomerBody.safeParse({
      ...validBody,
      nextOfKin: { fullName: 'Kofi Mensah', phone: validBody.phone },
    });
    expect(result.success).toBe(false);
  });

  it('accepts distinct phones', () => {
    const result = createCustomerBody.safeParse({
      ...validBody,
      altPhone: '0551234567',
      nextOfKin: { fullName: 'Kofi Mensah', phone: '0209876543' },
    });
    expect(result.success).toBe(true);
  });
});

describe('identification per-type formats', () => {
  const cases: [string, string, boolean][] = [
    ['ghana-card', 'GHA-123456789-0', true],
    ['ghana-card', 'GHA-12345-0', false],
    ['voter-id', '12345678', true],
    ['voter-id', '1234567', false],
    ['voter-id', '123456789', false],
    ['voter-id', '1234567a', false],
    ['passport', 'G12345678', true],
    ['passport', 'A12345678', true],
    ['passport', 'g12345678', false],
    ['passport', 'G1234567', false],
    ['passport', 'GH1234567', false],
    ['drivers-license', 'ABC1234567', true],
    ['drivers-license', 'AB-12345-6789', true],
    ['drivers-license', 'SHORT1', false],
    ['drivers-license', 'X'.repeat(21), false],
  ];

  it.each(cases)('%s %s → valid=%s', (idType, idNumber, valid) => {
    expect(identification.safeParse({ idType, idNumber }).success).toBe(valid);
  });
});

describe('dateOfBirth minimum age', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('rejects customers under 10 and evaluates the cutoff per parse', () => {
    vi.setSystemTime(new Date('2026-08-10T12:00:00Z'));
    const nineYearsOld = { ...validBody, dateOfBirth: '2017-01-01' };
    expect(createCustomerBody.safeParse(nineYearsOld).success).toBe(false);

    // Same input becomes valid once the clock moves past the 10th birthday —
    // proving the cutoff is not frozen at module load.
    vi.setSystemTime(new Date('2027-01-02T12:00:00Z'));
    expect(createCustomerBody.safeParse(nineYearsOld).success).toBe(true);
  });

  it('accepts a customer exactly 10 years old', () => {
    vi.setSystemTime(new Date('2026-08-10T12:00:00Z'));
    expect(createCustomerBody.safeParse({ ...validBody, dateOfBirth: '2016-08-10' }).success).toBe(
      true,
    );
  });
});
