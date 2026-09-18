import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCustomerBody,
  identification,
  phoneClashes,
  reassignCollectorBody,
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

describe('dateOfBirth — no minimum age, past dates only', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('accepts a child', () => {
    vi.setSystemTime(new Date('2026-08-10T12:00:00Z'));
    expect(createCustomerBody.safeParse({ ...validBody, dateOfBirth: '2024-03-01' }).success).toBe(
      true,
    );
  });

  it('accepts a birth date of today', () => {
    vi.setSystemTime(new Date('2026-08-10T12:00:00Z'));
    expect(createCustomerBody.safeParse({ ...validBody, dateOfBirth: '2026-08-10' }).success).toBe(
      true,
    );
  });

  it('rejects a future date and evaluates "now" per parse', () => {
    vi.setSystemTime(new Date('2026-08-10T12:00:00Z'));
    const tomorrow = { ...validBody, dateOfBirth: '2026-08-11' };
    expect(createCustomerBody.safeParse(tomorrow).success).toBe(false);

    // Same input becomes valid once the clock moves past it — proving "now"
    // is not frozen at module load.
    vi.setSystemTime(new Date('2026-08-12T12:00:00Z'));
    expect(createCustomerBody.safeParse(tomorrow).success).toBe(true);
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

  it('lets the office clear a next-of-kin phone and an occupation', () => {
    const result = updateCustomerBody.safeParse({
      occupation: '',
      nextOfKin: { fullName: 'Kofi Mensah', phone: '', relationship: '' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.occupation).toBeNull();
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
  it('allows registration with no collector — the customer who pays at the counter', () => {
    // Not everyone is collected from. Plenty of customers bring their deposits
    // to the office, and those belong to no round at all.
    const { assignedCollectorId: _omitted, ...noCollector } = validBody;
    const result = createCustomerBody.safeParse(noCollector);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.assignedCollectorId).toBeUndefined();
  });

  it('lets an admin take a customer off every round', () => {
    // The other half of the same rule: a customer who starts on a round can be
    // moved to paying at the counter, which is `null` rather than a collector.
    expect(reassignCollectorBody.safeParse({ collectorId: null }).success).toBe(true);
    expect(reassignCollectorBody.safeParse({ collectorId: COLLECTOR_ID }).success).toBe(true);
    expect(reassignCollectorBody.safeParse({ collectorId: 'not-an-id' }).success).toBe(false);
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

describe('the ID document is optional on the profile', () => {
  it('registers a customer with neither side of the ID uploaded', () => {
    const { idDocumentFrontUrl: _front, idDocumentBackUrl: _back, ...noScans } = validBody;
    const result = createCustomerBody.safeParse(noScans);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.idDocumentFrontUrl).toBeUndefined();
      expect(result.data.idDocumentBackUrl).toBeUndefined();
    }
  });

  it('reads the blank fields a registration form submits as "no scan"', () => {
    const result = createCustomerBody.safeParse({
      ...validBody,
      idDocumentFrontUrl: '',
      idDocumentBackUrl: '',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.idDocumentFrontUrl).toBeNull();
  });

  it('still requires the customer photo', () => {
    const { photoUrl: _photo, ...noPhoto } = validBody;
    expect(createCustomerBody.safeParse(noPhoto).success).toBe(false);
  });

  it('lets an edit clear a scan, and still refuses a URL from elsewhere', () => {
    for (const cleared of ['', null]) {
      const result = updateCustomerBody.safeParse({ idDocumentBackUrl: cleared });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.idDocumentBackUrl).toBeNull();
    }
    expect(
      updateCustomerBody.safeParse({ idDocumentBackUrl: 'https://example.com/back.jpg' }).success,
    ).toBe(false);
  });
});
