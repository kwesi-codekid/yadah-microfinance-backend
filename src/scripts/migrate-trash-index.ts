/**
 * One-time migration for the trash feature. Run BEFORE deploying the code
 * that trashes savings transactions:
 *
 *   npx tsx src/scripts/migrate-trash-index.ts
 *
 * The savings 1-withdrawal-per-Accra-day unique index used to key on
 * `type in [withdrawal, closure]`. Partial indexes cannot express
 * `deletedAt: null`, so the marker moves to an explicit boolean —
 * `countsTowardDailyLimit: true` — which trash/restore unset/set. This script
 * drops the old index, backfills the flag on existing withdrawal/closure
 * transactions, and rebuilds indexes from the schema definition.
 */
import { connectDb, disconnectDb } from '../lib/db.js';
import { SavingsTxnModel } from '../models/index.js';

const OLD_INDEX = 'accountId_1_accraDay_1';

async function main(): Promise<void> {
  await connectDb();

  const indexes = await SavingsTxnModel.collection.indexes();
  const existing = indexes.find((i) => i.name === OLD_INDEX);
  if (existing && !('countsTowardDailyLimit' in (existing.partialFilterExpression ?? {}))) {
    await SavingsTxnModel.collection.dropIndex(OLD_INDEX);
    console.log(`dropped old index ${OLD_INDEX}`);
  } else {
    console.log('old index already migrated or absent');
  }

  const backfill = await SavingsTxnModel.updateMany(
    {
      type: { $in: ['withdrawal', 'closure'] },
      deletedAt: null,
      countsTowardDailyLimit: { $exists: false },
    },
    { $set: { countsTowardDailyLimit: true } },
  );
  console.log(`backfilled countsTowardDailyLimit on ${String(backfill.modifiedCount)} txns`);

  await SavingsTxnModel.syncIndexes();
  console.log('indexes synced');

  await disconnectDb();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
