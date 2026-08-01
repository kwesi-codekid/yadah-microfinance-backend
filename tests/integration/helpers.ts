import mongoose, { Types } from 'mongoose';
import { connectDb, disconnectDb } from '../../src/lib/db.js';
import {
  CustomerModel,
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
      SavingsAccountModel,
      SavingsTxnModel,
      LoanModel,
      LoanScheduleModel,
      RepaymentModel,
      UserModel,
    ].map((m) => m.syncIndexes()),
  );
}

export async function teardownDb(): Promise<void> {
  await disconnectDb();
}

export function asOfficer(): AccessTokenPayload {
  return { sub: new Types.ObjectId().toHexString(), role: 'admin' };
}

let phoneCounter = 100;

export async function makeCustomer(withGhanaCard = false): Promise<Types.ObjectId> {
  phoneCounter += 1;
  const customer = await CustomerModel.create({
    fullName: `Test Customer ${String(phoneCounter)}`,
    phone: `05000${String(phoneCounter).padStart(5, '0')}`,
    registeredById: new Types.ObjectId(),
    status: 'active',
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
