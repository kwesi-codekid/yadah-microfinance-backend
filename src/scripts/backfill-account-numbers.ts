/**
 * One-off backfill: assigns account numbers to susu/savings accounts
 * created before the accountNumber field existed. Idempotent.
 * Run: npx tsx src/scripts/backfill-account-numbers.ts
 */
import { connectDb, disconnectDb } from '../lib/db.js';
import {
  generateAccountNumber,
  SAVINGS_ACCOUNT_DIGITS,
  SUSU_ACCOUNT_DIGITS,
} from '../lib/account-number.js';
import { SavingsAccountModel, SusuAccountModel } from '../models/index.js';

await connectDb();

const susuMissing = await SusuAccountModel.find({ accountNumber: { $exists: false } });
for (const account of susuMissing) {
  await SusuAccountModel.updateOne(
    { _id: account._id },
    { $set: { accountNumber: generateAccountNumber(SUSU_ACCOUNT_DIGITS) } },
  );
}
console.log(`susu accounts backfilled: ${String(susuMissing.length)}`);

const savingsMissing = await SavingsAccountModel.find({ accountNumber: { $exists: false } });
for (const account of savingsMissing) {
  await SavingsAccountModel.updateOne(
    { _id: account._id },
    { $set: { accountNumber: generateAccountNumber(SAVINGS_ACCOUNT_DIGITS) } },
  );
}
console.log(`savings accounts backfilled: ${String(savingsMissing.length)}`);

await SusuAccountModel.syncIndexes();
await SavingsAccountModel.syncIndexes();
console.log('indexes synced');
await disconnectDb();
