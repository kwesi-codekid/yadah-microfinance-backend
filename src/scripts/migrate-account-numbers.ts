/**
 * One-off migration for the PREFIX+YYMM+NNNN account-number scheme.
 *
 * Loans and hire-purchase agreements never had a number, so nothing can break
 * by giving them one — they are backfilled here, numbered by their own
 * creation month so the date segment stays truthful.
 *
 * Susu and savings accounts are deliberately NOT renumbered: their existing
 * numbers are printed on receipts and quoted by customers. Both models accept
 * the legacy and the new shape; only accounts opened from now on get the new
 * format.
 *
 * Idempotent — re-running only fills records that are still missing a number.
 * Run before deploying: npx tsx src/scripts/migrate-account-numbers.ts
 */
import {
  accountPeriodKey,
  formatAccountNumber,
  raiseCounter,
  type AccountPrefix,
} from '../lib/account-number.js';
import { connectDb, disconnectDb } from '../lib/db.js';
import { CounterModel } from '../models/counter.model.js';
import {
  HpAgreementModel,
  LoanModel,
  SavingsAccountModel,
  SusuAccountModel,
} from '../models/index.js';
import type { Types } from 'mongoose';

await connectDb();

interface Numbered {
  _id: Types.ObjectId;
  accountNumber?: string;
  createdAt: Date;
}

/**
 * The slice of a Mongoose model this script needs. Loans and HP agreements
 * have unrelated document types, so they are addressed structurally rather
 * than through a union that would have to name every field of both.
 */
interface NumberableModel {
  find: (
    filter: Record<string, unknown>,
    projection?: Record<string, number>,
  ) => {
    sort: (s: Record<string, number>) => { lean: () => Promise<unknown> };
    lean: () => Promise<unknown>;
  };
  updateOne: (filter: Record<string, unknown>, update: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Assign numbers oldest-first so the sequence within each month follows the
 * order the records were actually created. Counters are then raised past the
 * highest number issued, so live openings never collide with a backfilled one.
 */
async function backfill(
  model: NumberableModel,
  prefix: AccountPrefix,
  label: string,
): Promise<void> {
  const missing = (await model
    .find({ accountNumber: { $exists: false } })
    .sort({ createdAt: 1 })
    .lean()) as Numbered[];

  // Seed each month's counter from numbers already issued in that month, so a
  // partially-completed previous run is continued rather than duplicated.
  const seqByPeriod = new Map<string, number>();
  const existing = (await model
    .find({ accountNumber: { $exists: true } }, { accountNumber: 1 })
    .lean()) as Numbered[];
  for (const doc of existing) {
    const number = doc.accountNumber;
    if (!number) continue;
    const period = number.slice(2, 6);
    // Bounded slice: a susu number may carry a `-MMM` cycle-month tail, and
    // Number('0005-SEP') is NaN, which would drop the number from the seed
    // and let the counter hand it out a second time.
    const seq = Number(number.slice(6, 10));
    if (Number.isFinite(seq)) seqByPeriod.set(period, Math.max(seqByPeriod.get(period) ?? 0, seq));
  }

  for (const doc of missing) {
    const period = accountPeriodKey(doc.createdAt);
    const seq = (seqByPeriod.get(period) ?? 0) + 1;
    seqByPeriod.set(period, seq);
    await model.updateOne(
      { _id: doc._id },
      { $set: { accountNumber: formatAccountNumber(prefix, period, seq) } },
    );
  }

  for (const [period, seq] of seqByPeriod) {
    await raiseCounter(prefix, period, seq);
  }
  console.log(
    `${label}: ${String(missing.length)} numbered, ${String(seqByPeriod.size)} month counters set`,
  );
}

await backfill(LoanModel as unknown as NumberableModel, 'LN', 'loans');
await backfill(HpAgreementModel as unknown as NumberableModel, 'HP', 'hp agreements');

// Susu and savings keep their legacy numbers; their counters simply start at 0
// for the current month. Nothing to reconcile — the old numbers are pure
// digits and can never collide with a prefixed one.
const period = accountPeriodKey();
for (const prefix of ['SU', 'SV'] as const) {
  await CounterModel.updateOne(
    { _id: `${prefix}-${period}` },
    { $setOnInsert: { seq: 0 } },
    { upsert: true },
  );
}
console.log(`susu/savings counters ready for ${period} (existing numbers untouched)`);

await Promise.all([
  LoanModel.syncIndexes(),
  HpAgreementModel.syncIndexes(),
  SusuAccountModel.syncIndexes(),
  SavingsAccountModel.syncIndexes(),
]);
console.log('indexes synced');

await disconnectDb();
