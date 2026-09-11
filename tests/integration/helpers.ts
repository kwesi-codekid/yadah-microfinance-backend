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

/**
 * A registered customer with the photo and both ID scans on file, as the
 * office normally leaves them. Pass `withIdDocument: false` for the profile
 * that cannot open credit yet.
 */
export async function makeCustomer(
  withGhanaCard = false,
  assignedCollectorId?: Types.ObjectId,
  options: { withIdDocument?: boolean } = {},
): Promise<Types.ObjectId> {
  phoneCounter += 1;
  const withIdDocument = options.withIdDocument ?? true;
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
    ...(withGhanaCard
      ? {
          identification: {
            idType: 'ghana-card',
            idNumber: `GHA-${String(100000000 + phoneCounter)}-1`,
          },
        }
      : {}),
  });
  return customer._id;
}
