import mongoose, { Types } from 'mongoose';
import { connectDb, disconnectDb } from '../../src/lib/db.js';
import {
  CapitalEntryModel,
  CashAccountModel,
  CustomerModel,
  ExpenseModel,
  FixedAssetModel,
  HpAgreementModel,
  HpDamageModel,
  HpItemModel,
  HpPriceChangeModel,
  PayoutRequestModel,
  PortalOtpModel,
  PortalSessionModel,
  HpSaleModel,
  LoanModel,
  LoanScheduleModel,
  RepaymentModel,
  SavingsAccountModel,
  SavingsTxnModel,
  SusuAccountModel,
  SusuDepositModel,
  UserModel,
} from '../../src/models/index.js';
import type { AccessTokenPayload } from '../../src/modules/auth/auth.service.js';

export async function setupDb(): Promise<void> {
  await connectDb();
  const db = mongoose.connection.db;
  if (!db || db.databaseName !== 'yadah-test') {
    throw new Error(`refusing to run integration tests against "${db?.databaseName ?? '?'}"`);
  }
  await db.dropDatabase();
  // Unique/partial indexes are part of the behavior under test.
  await Promise.all(
    [
      CustomerModel,
      SusuAccountModel,
      SusuDepositModel,
      HpItemModel,
      HpDamageModel,
      HpPriceChangeModel,
      HpAgreementModel,
      HpSaleModel,
      SavingsAccountModel,
      SavingsTxnModel,
      LoanModel,
      LoanScheduleModel,
      RepaymentModel,
      UserModel,
      PayoutRequestModel,
      PortalOtpModel,
      PortalSessionModel,
      CashAccountModel,
      ExpenseModel,
      FixedAssetModel,
      CapitalEntryModel,
    ].map((m) => m.syncIndexes()),
  );
}

export async function teardownDb(): Promise<void> {
  await disconnectDb();
}

export function asOfficer(): AccessTokenPayload {
  return { sub: new Types.ObjectId().toHexString(), role: 'admin' };
}

/** A teller actor plus the user record their role is read from. */
export async function makeTeller(name = 'Counter Teller'): Promise<AccessTokenPayload> {
  collectorPhoneCounter += 1;
  const user = await UserModel.create({
    name,
    username: `teller-${new Types.ObjectId().toHexString()}`,
    phone: `0247${String(100000 + collectorPhoneCounter)}`,
    role: 'teller',
    status: 'active',
    passwordHash: 'x'.repeat(60),
  });
  return { sub: user._id.toHexString(), role: 'teller' };
}

let collectorPhoneCounter = 0;

/** A collector actor plus the user record the scope lock resolves against. */
export async function makeCollector(name = 'Field Collector'): Promise<AccessTokenPayload> {
  collectorPhoneCounter += 1;
  const user = await UserModel.create({
    name,
    username: `collector-${new Types.ObjectId().toHexString()}`,
    // Unique per call: `users.phone` carries a unique index, so a fixed number
    // lets only the first collector in a file be created.
    phone: `0244${String(100000 + collectorPhoneCounter)}`,
    role: 'collector',
    status: 'active',
    passwordHash: 'x'.repeat(60),
  });
  return { sub: user._id.toHexString(), role: 'collector' };
}

let phoneCounter = 100;

/** Where the uploads endpoint mints image URLs — the only host the schemas accept. */
export const CLOUDINARY = 'https://res.cloudinary.com/demo/image/upload';

/** A format-valid number per ID type, unique per customer. */
const ID_NUMBERS: Record<string, (n: number) => string> = {
  'ghana-card': (n) => `GHA-${String(100000000 + n)}-1`,
  passport: (n) => `G${String(10000000 + n)}`,
  'drivers-license': (n) => `DL${String(10000000 + n)}`,
  'voter-id': (n) => String(10000000 + n),
};

/**
 * A registered customer with the photo and both ID scans on file, as the
 * office normally leaves them. Pass `withIdDocument: false` for the profile
 * that cannot open credit yet.
 *
 * `options.idType` records that type of ID instead of a Ghana Card — credit
 * accepts any of them, and a fixture that only ever holds a card cannot show
 * it. `withGhanaCard` stays the first argument because most callers only care
 * whether there is an ID at all.
 */
export async function makeCustomer(
  withGhanaCard = false,
  assignedCollectorId?: Types.ObjectId,
  options: { withIdDocument?: boolean; idType?: string } = {},
): Promise<Types.ObjectId> {
  phoneCounter += 1;
  const withIdDocument = options.withIdDocument ?? true;
  const idType = options.idType ?? (withGhanaCard ? 'ghana-card' : null);
  const customer = await CustomerModel.create({
    fullName: `Test Customer ${String(phoneCounter)}`,
    phone: `05000${String(phoneCounter).padStart(5, '0')}`,
    registeredById: new Types.ObjectId(),
    status: 'active',
    photoUrl: `${CLOUDINARY}/photo.jpg`,
    ...(withIdDocument
      ? {
          idDocumentFrontUrl: `${CLOUDINARY}/front.jpg`,
          idDocumentBackUrl: `${CLOUDINARY}/back.jpg`,
        }
      : {}),
    ...(assignedCollectorId ? { assignedCollectorId } : {}),
    ...(idType
      ? {
          identification: {
            idType,
            idNumber: (ID_NUMBERS[idType] ?? ID_NUMBERS['ghana-card'])(phoneCounter),
          },
        }
      : {}),
  });
  return customer._id;
}

/**
 * Somebody fit to stand behind a loan: an ID recorded and both sides of it
 * photographed. The default is a passport rather than a Ghana Card, so every
 * happy path in the suite also shows that any ID type is accepted.
 */
export async function makeGuarantor(idType = 'passport'): Promise<Types.ObjectId> {
  return makeCustomer(false, undefined, { idType });
}
