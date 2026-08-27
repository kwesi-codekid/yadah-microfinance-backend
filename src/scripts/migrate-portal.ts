/**
 * One-off migration for the customer portal and collector round work.
 *
 * Creates indexes only — no documents are rewritten. The indexes matter for
 * correctness, not just speed:
 *   - payout-requests: a PARTIAL unique index on targetId where status is
 *     'pending', which is what actually stops a customer queueing two
 *     withdrawals against the same balance;
 *   - payout-requests: unique idempotencyKey and transferReference, so a
 *     retried approval can never apply a withdrawal twice;
 *   - portal-otps / portal-sessions: unique keys plus TTL indexes that expire
 *     stale codes and sessions without a cleanup job.
 *
 * Idempotent. Run before deploying: npx tsx src/scripts/migrate-portal.ts
 */
import { connectDb, disconnectDb } from '../lib/db.js';
import { PayoutRequestModel, PortalOtpModel, PortalSessionModel } from '../models/index.js';

await connectDb();

for (const model of [PayoutRequestModel, PortalOtpModel, PortalSessionModel]) {
  await model.syncIndexes();
  console.log(`${model.collection.name}: indexes synced`);
}

console.log('portal migration complete');
await disconnectDb();
