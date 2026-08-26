/**
 * One-off migration for the post-demo round (2026-08-21). Idempotent — safe to
 * run more than once, and safe to run before or after the collector backfill.
 *
 * Run: npx tsx src/scripts/migrate-post-demo.ts
 *
 * Does NOT assign collectors — that needs a human decision, so it lives in
 * src/scripts/backfill-collector-assignment.ts.
 */
import { connectDb, disconnectDb } from '../lib/db.js';
import {
  CustomerModel,
  HpSaleModel,
  NotificationModel,
  PushSubscriptionModel,
  ReconciliationModel,
  SusuAccountModel,
  SusuPayoutModel,
} from '../models/index.js';

await connectDb();

// Partial withdrawals: existing cycles have taken nothing out yet.
const withdrawn = await SusuAccountModel.updateMany(
  { withdrawnAmount: { $exists: false } },
  { $set: { withdrawnAmount: 0 } },
);
console.log(`susu accounts given withdrawnAmount=0: ${String(withdrawn.modifiedCount)}`);

// Every payout recorded before partial withdrawals existed ended an account.
const kinds = await SusuPayoutModel.updateMany(
  { kind: { $exists: false } },
  { $set: { kind: 'payout' } },
);
console.log(`susu payouts marked kind=payout: ${String(kinds.modifiedCount)}`);

// New collections and changed indexes.
await Promise.all([
  CustomerModel.syncIndexes(),
  SusuAccountModel.syncIndexes(),
  SusuPayoutModel.syncIndexes(),
  ReconciliationModel.syncIndexes(),
  NotificationModel.syncIndexes(),
  PushSubscriptionModel.syncIndexes(),
  HpSaleModel.syncIndexes(),
]);
console.log('indexes synced');

const unassigned = await CustomerModel.countDocuments({ assignedCollectorId: null });
if (unassigned > 0) {
  console.log(
    `\nWARNING: ${String(unassigned)} customers have no collector and are invisible in the field.\n` +
      'Run: npx tsx src/scripts/backfill-collector-assignment.ts --list',
  );
}

await disconnectDb();
