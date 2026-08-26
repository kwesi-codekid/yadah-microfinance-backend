import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCustomerBody,
  identification,
  phoneClashes,
  updateCustomerBody,
} from './customers.schemas.js';

const COLLECTOR_ID = '650000000000000000000001';

const validBody = {
  fullName: 'Ama Mensah',
  phone: '0241234567',
  assignedCollectorId: COLLECTOR_ID,
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

describe('editing a customer — the demo bugs', () => {
  it('lets the office clear an alternate phone', () => {
    for (const cleared of ['', null]) {
      const result = updateCustomerBody.safeParse({ altPhone: cleared });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.altPhone).toBeNull();
    }
  });

  it('lets the office clear a next-of-kin phone and an email', () => {
    const result = updateCustomerBody.safeParse({
      email: '',
      nextOfKin: { fullName: 'Kofi Mensah', phone: '', relationship: '' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBeNull();
      expect(result.data.nextOfKin?.phone).toBeNull();
    }
  });

  it('accepts the formats people actually type, storing one canonical number', () => {
    for (const input of ['+233241234567', '233241234567', '024 123 4567']) {
      const result = updateCustomerBody.safeParse({ phone: input });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.phone).toBe('0241234567');
    }
  });

  it('rejects a duplicated alternate phone on update, as it does on create', () => {
    const result = updateCustomerBody.safeParse({
      phone: '0241234567',
      altPhone: '0241234567',
    });
    expect(result.success).toBe(false);
  });

  it('catches a clash across formats of the same number', () => {
    const result = updateCustomerBody.safeParse({
      phone: '0241234567',
      altPhone: '+233241234567',
    });
    expect(result.success).toBe(false);
  });

  it('still requires at least one field', () => {
    expect(updateCustomerBody.safeParse({}).success).toBe(false);
  });
});

describe('registering a customer with blank optional inputs', () => {
  it('accepts a form that submits empty strings for untouched fields', () => {
    const result = createCustomerBody.safeParse({
      ...validBody,
      email: '',
      altPhone: '',
      occupation: '',
      nationality: '',
    });
    expect(result.success).toBe(true);
  });

  it('normalizes the phone at registration too', () => {
    const result = createCustomerBody.safeParse({ ...validBody, phone: '+233 24 123 4567' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.phone).toBe('0241234567');
  });
});

describe('collector assignment', () => {
  it('requires a collector at registration — an unassigned customer is invisible in the field', () => {
    const { assignedCollectorId: _omitted, ...noCollector } = validBody;
    expect(createCustomerBody.safeParse(noCollector).success).toBe(false);
  });

  it('rejects a malformed collector id', () => {
    expect(
      createCustomerBody.safeParse({ ...validBody, assignedCollectorId: 'not-an-id' }).success,
    ).toBe(false);
  });

  it('ignores assignedCollectorId on the general edit route — reassignment is admin-only', () => {
    const result = updateCustomerBody.safeParse({
      occupation: 'Trader',
      assignedCollectorId: COLLECTOR_ID,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).assignedCollectorId).toBeUndefined();
    }
  });
});
