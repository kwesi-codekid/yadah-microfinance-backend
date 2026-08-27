import mongoose, { Types } from 'mongoose';
import { connectDb, disconnectDb } from '../../src/lib/db.js';
import {
  CapitalEntryModel,
  CashAccountModel,
  CustomerModel,
  ExpenseModel,
  FixedAssetModel,
  HpAgreementModel,
  HpItemModel,
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

/** A collector actor plus the user record the scope lock resolves against. */
export async function makeCollector(name = 'Field Collector'): Promise<AccessTokenPayload> {
  const user = await UserModel.create({
    name,
    username: `collector-${new Types.ObjectId().toHexString()}`,
    phone: '0244000000',
    role: 'collector',
    status: 'active',
    passwordHash: 'x'.repeat(60),
  });
  return { sub: user._id.toHexString(), role: 'collector' };
}

let phoneCounter = 100;

export async function makeCustomer(
  withGhanaCard = false,
  assignedCollectorId?: Types.ObjectId,
): Promise<Types.ObjectId> {
  phoneCounter += 1;
  const customer = await CustomerModel.create({
    fullName: `Test Customer ${String(phoneCounter)}`,
    phone: `05000${String(phoneCounter).padStart(5, '0')}`,
    registeredById: new Types.ObjectId(),
    status: 'active',
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
