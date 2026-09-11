/**
 * Backfill `commissionAmount` onto the susu payout rows that stopped an
 * account, so the closing commission shows in the transactions feed.
 *
 * The feed reads the commission off the payout row rather than the account
 * because an account can be stopped once and paid out in several instalments:
 * the charge belongs to the instalment that stopped it and to no other. Rows
 * written before that field existed carry nothing and read as zero, so this
 * is a display backfill — no money moves and no total changes.
 *
 * Which row gets it, per account: the EARLIEST payout at or after the moment
 * the account stopped. For an office closure that is the `close:<id>` row; for
 * a susu-funded loan repayment it is the loan leg; for a transfer it is the
 * credited leg. Later instalments are explicitly set to 0 so a re-run cannot
 * move the charge onto one of them.
 *
 * Accounts closed with a zero payout before this change wrote no payout row at
 * all and cannot be reached — their commission stays visible in
 * /reports/commission, which reads the account, not the feed.
 *
 * Idempotent. Run after deploying: npx tsx src/scripts/migrate-susu-commission.ts
 */
import { connectDb, disconnectDb } from '../lib/db.js';
import { SusuAccountModel, SusuPayoutModel } from '../models/index.js';

await connectDb();

const stopped = await SusuAccountModel.find(
  { commissionAmount: { $gt: 0 } },
  { _id: 1, commissionAmount: 1 },
).lean();

let charged = 0;
let zeroed = 0;
let unreachable = 0;

for (const account of stopped) {
  const commission = account.commissionAmount ?? 0;
  if (commission <= 0) continue;

  // A partial withdrawal is not a stopping row and must never carry the
  // charge, however early it was recorded.
  const payouts = await SusuPayoutModel.find({ accountId: account._id, kind: 'payout' }, { _id: 1 })
    .sort({ createdAt: 1, _id: 1 })
    .lean();

  const [first, ...rest] = payouts;
  if (!first) {
    unreachable += 1;
    continue;
  }

  const head = await SusuPayoutModel.updateOne(
    { _id: first._id },
    { $set: { commissionAmount: commission } },
  );
  if (head.modifiedCount === 1) charged += 1;

  if (rest.length > 0) {
    const tail = await SusuPayoutModel.updateOne(
      { _id: { $in: rest.map((p) => p._id) }, commissionAmount: { $ne: 0 } },
      { $set: { commissionAmount: 0 } },
    );
    zeroed += tail.modifiedCount;
  }
}

console.log(
  `susu commission: ${String(charged)} stopping row(s) charged, ` +
    `${String(zeroed)} instalment(s) zeroed, ` +
    `${String(unreachable)} account(s) had no payout row to carry it`,
);

await disconnectDb();
