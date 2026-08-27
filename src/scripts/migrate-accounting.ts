/**
 * One-off migration for the accounting module.
 *
 * Creates indexes only. The partial unique index on cash-accounts.channel is
 * the one that matters for correctness: two active accounts on one channel
 * would each claim the same customer transactions and double the reported
 * cash position.
 *
 * Idempotent. Run before deploying: npx tsx src/scripts/migrate-accounting.ts
 */
import { connectDb, disconnectDb } from '../lib/db.js';
import {
  CapitalEntryModel,
  CashAccountModel,
  ExpenseModel,
  FixedAssetModel,
} from '../models/index.js';

await connectDb();

for (const model of [CashAccountModel, ExpenseModel, FixedAssetModel, CapitalEntryModel]) {
  await model.syncIndexes();
  console.log(`${model.collection.name}: indexes synced`);
}

console.log(
  'accounting migration complete — remember to create a cash account with its opening ' +
    'balance AND a matching opening capital contribution, or the balance sheet will ' +
    'report a non-zero checkDifference.',
);
await disconnectDb();
