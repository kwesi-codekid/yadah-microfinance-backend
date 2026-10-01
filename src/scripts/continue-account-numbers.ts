/**
 * Make each product's account-number sequence run on across months.
 *
 *   npx tsx src/scripts/continue-account-numbers.ts            # dry run: reports, writes nothing
 *   npx tsx src/scripts/continue-account-numbers.ts --apply    # writes
 *   npx tsx src/scripts/continue-account-numbers.ts --apply --only=SV26100001,SU26100002
 *                                                   # renumber only these; others this month stay
 *
 * Until 1 Oct 2026 the sequence restarted at 0001 each month, which read to
 * customers as starting over (client decision, 1 Oct 2026). Numbers from the
 * months already past keep their values — they are on receipts and cards —
 * and `YYMM` keeps them apart. For the CURRENT month, whose numbers were
 * issued from 0001 under the old rule, each product's accounts are renumbered
 * in the order they were opened to continue from the highest sequence any
 * earlier month reached; then the product's one counter is set past the
 * highest number in use, so the next account carries on from there.
 *
 * A susu number is also held on the customer (`susuNumber`), and is moved
 * with the account. Idempotent: a month whose numbers already run past every
 * earlier month is left alone. Refuses a non-local host without --allow-remote.
 */
import mongoose, { Types } from 'mongoose';
import { connectDb, disconnectDb } from '../lib/db.js';
import { env } from '../config/env.js';
import {
  CustomerModel,
  HpAgreementModel,
  LoanModel,
  SavingsAccountModel,
  SusuAccountModel,
} from '../models/index.js';
import {
  accountPeriodKey,
  formatAccountNumber,
  parseAccountNumber,
  raiseCounter,
  type AccountPrefix,
} from '../lib/account-number.js';

const APPLY = process.argv.includes('--apply');
const ALLOW_REMOTE = process.argv.includes('--allow-remote');
/** `--only=A,B`: renumber just these account numbers; the rest of the month is left as it is. */
const ONLY = process.argv
  .filter((a) => a.startsWith('--only='))
  .flatMap((a) => a.slice('--only='.length).split(','))
  .map((n) => n.trim())
  .filter(Boolean);

const PRODUCTS: { prefix: AccountPrefix; label: string; collection: mongoose.Collection }[] = [
  { prefix: 'SU', label: 'susu', collection: SusuAccountModel.collection },
  { prefix: 'SV', label: 'savings', collection: SavingsAccountModel.collection },
  { prefix: 'LN', label: 'loans', collection: LoanModel.collection },
  { prefix: 'HP', label: 'hire purchase', collection: HpAgreementModel.collection },
];

export interface ContinueSummary {
  /** Per prefix: how many of this month's accounts were renumbered, and the counter set. */
  products: Record<string, { renumbered: number; counter: number }>;
}

export async function continueAccountNumbers(
  apply: boolean,
  now: Date = new Date(),
  /** When given, only these account numbers are renumbered; the counter still clears everything. */
  only: readonly string[] = [],
): Promise<ContinueSummary> {
  const summary: ContinueSummary = { products: {} };
  const period = accountPeriodKey(now);

  for (const { prefix, label, collection } of PRODUCTS) {
    const docs = (await collection
      .find(
        { accountNumber: { $regex: `^${prefix}[0-9]{8,}$` } },
        { projection: { accountNumber: 1, createdAt: 1 } },
      )
      .toArray()) as unknown as { _id: Types.ObjectId; accountNumber: string; createdAt: Date }[];

    let highestBefore = 0;
    const thisMonth: typeof docs = [];
    for (const d of docs) {
      const parsed = parseAccountNumber(d.accountNumber);
      if (!parsed) continue;
      if (parsed.period < period) highestBefore = Math.max(highestBefore, parsed.seq);
      else if (parsed.period === period) thisMonth.push(d);
    }
    thisMonth.sort(
      (x, y) =>
        x.createdAt.getTime() - y.createdAt.getTime() ||
        (parseAccountNumber(x.accountNumber)?.seq ?? 0) -
          (parseAccountNumber(y.accountNumber)?.seq ?? 0),
    );

    // Already running past every earlier month: nothing to renumber.
    const lowestThisMonth = Math.min(
      ...thisMonth.map((d) => parseAccountNumber(d.accountNumber)?.seq ?? Infinity),
    );
    const restarted = thisMonth.length > 0 && lowestThisMonth <= highestBefore;

    let renumbered = 0;
    let highest: number;
    if (restarted) {
      // Two passes: park every number on a temporary value first, so a new
      // number never collides with an old one still in the unique index.
      // Each chosen account takes the next value after the highest; one left
      // alone keeps its number and takes no value.
      let next = highestBefore;
      const plan = thisMonth.map((d) => {
        const chosen = only.length === 0 || only.includes(d.accountNumber);
        if (!chosen) return { id: d._id, from: d.accountNumber, to: d.accountNumber };
        next += 1;
        return { id: d._id, from: d.accountNumber, to: formatAccountNumber(prefix, period, next) };
      });
      for (const p of plan) {
        if (p.from !== p.to) {
          console.log(`${label}: ${p.from} -> ${p.to}`);
          renumbered += 1;
        }
      }
      highest = next;
      if (apply && renumbered > 0) {
        for (const p of plan) {
          if (p.from === p.to) continue;
          await collection.updateOne({ _id: p.id }, { $set: { accountNumber: `~${p.to}` } });
        }
        for (const p of plan) {
          if (p.from === p.to) continue;
          await collection.updateOne({ _id: p.id }, { $set: { accountNumber: p.to } });
          if (prefix === 'SU') {
            await CustomerModel.collection.updateOne(
              { susuNumber: p.from },
              { $set: { susuNumber: p.to } },
            );
          }
        }
      }
    } else {
      highest = Math.max(
        highestBefore,
        ...thisMonth.map((d) => parseAccountNumber(d.accountNumber)?.seq ?? 0),
      );
    }

    if (apply) await raiseCounter(prefix, highest);
    summary.products[prefix] = { renumbered, counter: highest };
    console.log(
      `${label}: ${String(renumbered)} renumbered this month, counter -> ${String(highest)}`,
    );
  }
  return summary;
}

async function main(): Promise<void> {
  const host = new URL(env.MONGO_URI.replace(/^mongodb(\+srv)?:\/\//, 'http://')).hostname;
  const local = host === '127.0.0.1' || host === 'localhost';
  if (!local && !ALLOW_REMOTE) {
    console.error(`Refusing to run against ${host} — pass --allow-remote to override.`);
    process.exit(2);
  }
  await connectDb();
  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} on ${host}`);
  if (ONLY.length > 0) console.log(`Only: ${ONLY.join(', ')}`);
  console.log(await continueAccountNumbers(APPLY, new Date(), ONLY));
  await disconnectDb();
}

const invokedDirectly = process.argv[1]
  ?.replace(/\\/g, '/')
  .endsWith('continue-account-numbers.ts');
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
