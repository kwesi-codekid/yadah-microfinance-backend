import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accraDay } from '../../src/lib/time.js';
import { CustomerModel, PortalOtpModel } from '../../src/models/index.js';
import {
  createCustomer,
  listCustomers,
  updateCustomer,
} from '../../src/modules/customers/customers.service.js';
import {
  createCustomerBody,
  updateCustomerBody,
} from '../../src/modules/customers/customers.schemas.js';
import { validateRows, blankRow } from '../../src/modules/customers/customers.import.js';
import * as hp from '../../src/modules/hire-purchase/hp.service.js';
import * as loans from '../../src/modules/loans/loans.service.js';
import * as portalAuth from '../../src/modules/portal/portal-auth.service.js';
import { CLOUDINARY, asOfficer, makeGuarantor, setupDb, teardownDb } from './helpers.js';

beforeAll(setupDb);
afterAll(teardownDb);

const officer = asOfficer();

function parseWith<T>(schema: { safeParse: (v: unknown) => unknown }, input: unknown): T {
  const parsed = schema.safeParse(input) as
    { success: true; data: T } | { success: false; error: { issues: unknown } };
  if (!parsed.success) throw new Error(`rejected: ${JSON.stringify(parsed.error.issues)}`);
  return parsed.data;
}

/** A birth date `years` years before today, give or take `days`. */
function bornYearsAgo(years: number, days = 0): string {
  const today = accraDay();
  const year = String(Number(today.slice(0, 4)) - years);
  const d = new Date(`${year}${today.slice(4)}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return accraDay(d);
}

let seq = 0;
function register(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return createCustomer(
    officer,
    parseWith<Parameters<typeof createCustomer>[1]>(createCustomerBody, {
      fullName: `Family Member ${String(seq)}`,
      phone: `0209${String(100000 + seq)}`,
      photoUrl: `${CLOUDINARY}/photo.jpg`,
      idDocumentFrontUrl: `${CLOUDINARY}/front.jpg`,
      idDocumentBackUrl: `${CLOUDINARY}/back.jpg`,
      ...overrides,
    }),
  );
}

const MUM = '0241112233';

describe('children on a parent’s phone number', () => {
  it('lets two children share their mother’s number, before and after she registers', async () => {
    const first = await register({ phone: MUM, dateOfBirth: bornYearsAgo(9) });
    const mum = await register({ phone: MUM, dateOfBirth: bornYearsAgo(35) });
    const second = await register({
      phone: MUM,
      dateOfBirth: bornYearsAgo(6),
      identification: { idType: 'nhis', idNumber: '25854039' },
    });
    expect(first.isMinor).toBe(true);
    expect(second.isMinor).toBe(true);
    expect(mum.isMinor).toBe(false);
  });

  it('still refuses a second adult on the same number', async () => {
    await expect(register({ phone: MUM, dateOfBirth: bornYearsAgo(40) })).rejects.toMatchObject({
      code: 'PHONE_TAKEN',
    });
  });

  it('treats a profile with no date of birth as an adult', async () => {
    await expect(register({ phone: MUM })).rejects.toMatchObject({ code: 'PHONE_TAKEN' });
  });

  it('asks for their own number on the first edit once a child is 18', async () => {
    const child = await register({ phone: MUM, dateOfBirth: bornYearsAgo(10) });
    // Their birthday has come round since they were registered.
    await CustomerModel.updateOne(
      { _id: child.id },
      { $set: { dateOfBirth: new Date(`${bornYearsAgo(18)}T00:00:00.000Z`) } },
    );
    const id = new Types.ObjectId(child.id);
    const edit = (body: Record<string, unknown>) =>
      updateCustomer(officer, id, parseWith(updateCustomerBody, body));

    await expect(edit({ occupation: 'Student' })).rejects.toMatchObject({ code: 'PHONE_TAKEN' });

    const own = await edit({ occupation: 'Student', phone: '0247778899' });
    expect(own.isMinor).toBe(false);
    expect((await CustomerModel.findById(id))?.isMinor).toBe(false);
  });

  it('opens the adult’s portal login on a shared number, never a child’s', async () => {
    const mum = await CustomerModel.findOne({ phone: MUM, isMinor: false });
    await portalAuth.requestOtp(MUM);
    const otp = await PortalOtpModel.findOne({ phone: MUM });
    expect(otp?.customerId.toHexString()).toBe(mum?._id.toHexString());

    await PortalOtpModel.updateOne(
      { _id: otp?._id },
      { $set: { codeHash: createHash('sha256').update('1234').digest('hex') } },
    );
    const { customer } = await portalAuth.verifyOtp(MUM, '1234');
    expect(customer.id).toBe(mum?._id.toHexString());
  });

  it('filters the listing by age', async () => {
    const children = await listCustomers(officer, { page: 1, limit: 100, age: 'child' } as never);
    const adults = await listCustomers(officer, { page: 1, limit: 100, age: 'adult' } as never);
    expect(children.items.every((c) => c.isMinor)).toBe(true);
    expect(adults.items.every((c) => !c.isMinor)).toBe(true);
    expect(children.total).toBeGreaterThanOrEqual(2);
  });
});

describe('NHIS numbers', () => {
  const nhis = (idNumber: string) =>
    createCustomerBody.safeParse({
      fullName: 'Nhis Check',
      phone: '0241234567',
      photoUrl: `${CLOUDINARY}/photo.jpg`,
      identification: { idType: 'nhis', idNumber },
    }).success;

  it('takes 8 digits or a Ghana Card number, nothing else', () => {
    expect(nhis('25854039')).toBe(true);
    expect(nhis('GHA-123456789-0')).toBe(true);
    expect(nhis('2585403')).toBe(false);
    expect(nhis('ABC12345')).toBe(false);
  });
});

describe('no credit for children', () => {
  /** Identified well enough to borrow, so age is the only thing in the way. */
  const identified = (dateOfBirth: string) =>
    register({
      dateOfBirth,
      identification: { idType: 'passport', idNumber: `G${String(10_000_000 + seq)}` },
    });

  it('refuses a loan to a 17-year-old and allows one at 18', async () => {
    const guarantor = await makeGuarantor();
    const minor = await identified(bornYearsAgo(18, 1));
    await expect(
      loans.applyForLoan(officer, new Types.ObjectId(minor.id), 100_000, 3, guarantor),
    ).rejects.toMatchObject({ code: 'CUSTOMER_MINOR' });

    const adult = await identified(bornYearsAgo(18));
    await expect(
      loans.applyForLoan(officer, new Types.ObjectId(adult.id), 100_000, 3, guarantor),
    ).resolves.toBeDefined();
  });

  it('refuses a child as a guarantor', async () => {
    const borrower = await identified(bornYearsAgo(30));
    const child = await identified(bornYearsAgo(12));
    await expect(
      loans.applyForLoan(
        officer,
        new Types.ObjectId(borrower.id),
        100_000,
        3,
        new Types.ObjectId(child.id),
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_MINOR' });
  });

  it('gives under 18 as a reason a child cannot take hire purchase', async () => {
    const child = await identified(bornYearsAgo(15));
    const eligibility = await hp.hpEligibility(new Types.ObjectId(child.id));
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reasons).toContain('Customers under 18 cannot take a loan or hire purchase');
  });
});

describe('importing children', () => {
  it('does not flag a child row that carries a parent’s number', async () => {
    const row = (n: number, values: Record<string, string>) => ({
      row: n,
      values: { ...blankRow(), ...values },
    });
    const preview = await validateRows([
      row(2, { fullName: 'KOFI CHILD', phone: MUM, dateOfBirth: bornYearsAgo(8) }),
      row(3, { fullName: 'ADULT CLASH', phone: MUM, dateOfBirth: bornYearsAgo(30) }),
    ]);
    const phoneIssues = (n: number) =>
      preview.rows.find((r) => r.row === n)?.issues.filter((i) => i.field === 'phone') ?? [];
    expect(phoneIssues(2)).toEqual([]);
    expect(phoneIssues(3)).not.toEqual([]);
  });
});
