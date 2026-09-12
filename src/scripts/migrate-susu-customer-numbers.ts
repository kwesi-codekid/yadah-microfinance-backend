/**
 * One-time migration for the per-customer susu number (client decision,
 * 12 Sep 2026). Run BEFORE deploying the code that opens a second book:
 *
 *   npx tsx src/scripts/migrate-susu-customer-numbers.ts --dry-run   # writes nothing
 *   npx tsx src/scripts/migrate-susu-customer-numbers.ts
 *
 * Run the dry pass first. It reports exactly what would change — how many
 * numbers collapse, onto what, and whether anything blocks the migration —
 * and touches neither the data nor the indexes.
 *
 * A susu customer is assigned ONE number, for life, and their books are
 * separated by month inside it — the way the manual passbooks have always
 * worked. So every account a customer holds is collapsed onto the number of
 * their oldest one, wearing its own cycle month: a customer showing
 * SU26090009-SEP and SU26090010-SEP ends up showing SU26090009-SEP twice.
 *
 * Three things this script does, in this order, and the order is the whole
 * point:
 *
 *   1. Drops the unique index on susu-accounts.accountNumber. Duplicates are
 *      now legitimate, and every rewrite below would fail E11000 against it.
 *      Mongoose does not drop indexes on its own — autoIndex only ever creates
 *      — so leaving this to the schema would leave production enforcing
 *      uniqueness while the tests, which drop their database first, look fine.
 *   2. Claims each customer's number on their own record, which is where the
 *      one surviving uniqueness rule lives.
 *   3. Rewrites the sibling accounts, keeping what each was originally issued
 *      in `issuedNumber` so a receipt already printed still finds its book.
 *
 * Idempotent. The number adopted is the oldest account's by
 * {createdAt, _id}, which is a fixed point: a second run rewrites nothing,
 * and it is the same rule the live opening path uses, so the two cannot
 * disagree. Counters are left alone — the sequence values freed by collapsing
 * are on printed receipts and must never be handed out again.
 *
 * Reversible: `accountNumber` can be restored from `issuedNumber` and the
 * customer's `susuNumber` unset, which is why the original is kept rather
 * than overwritten.
 */
import {
  bareAccountNumber,
  cycleMonthFrom,
  withCycleMonth,
  type CycleMonth,
} from '../lib/account-number.js';
import { connectDb, disconnectDb } from '../lib/db.js';
import { CustomerModel, SusuAccountModel } from '../models/index.js';
import type { Types } from 'mongoose';

const UNIQUE_INDEX = 'accountNumber_1';

/** `--dry-run` reports and writes nothing. Everything below honours it. */
const DRY = process.argv.includes('--dry-run');
const say = (line: string): void => {
  console.log(`${DRY ? '[dry] ' : ''}${line}`);
};

interface AccountRow {
  _id: Types.ObjectId;
  customerId: Types.ObjectId;
  accountNumber: string;
  issuedNumber?: string;
  cycleMonth?: CycleMonth;
  createdAt: Date;
}

async function dropUniqueIndex(): Promise<void> {
  const indexes = await SusuAccountModel.collection.indexes();
  const existing = indexes.find((i) => i.name === UNIQUE_INDEX);
  if (!existing) {
    say(`${UNIQUE_INDEX}: absent`);
    return;
  }
  if (existing.unique !== true) {
    say(`${UNIQUE_INDEX}: already non-unique`);
    return;
  }
  if (DRY) {
    say(`${UNIQUE_INDEX}: WOULD BE DROPPED (is unique) — every rewrite below needs this`);
    return;
  }
  await SusuAccountModel.collection.dropIndex(UNIQUE_INDEX);
  say(`${UNIQUE_INDEX}: dropped (was unique)`);
}

/**
 * Two customers must never end up on one stem — it is the single uniqueness
 * this scheme still has, and `syncIndexes` builds a unique index on it at the
 * end. A collision cannot arise from clean data (the old unique index made it
 * impossible), but a half-finished earlier run or a hand-edited record could,
 * and finding out when the index build throws would leave the database half
 * migrated. So it is checked before anything is written.
 */
function reportStemCollisions(stems: Map<string, string[]>): boolean {
  const clashes = [...stems.entries()].filter(([, owners]) => owners.length > 1);
  if (clashes.length === 0) return false;
  console.error(`BLOCKED: ${String(clashes.length)} stem(s) claimed by more than one customer:`);
  for (const [stem, owners] of clashes.slice(0, 20)) {
    console.error(`  ${stem} -> ${owners.join(', ')}`);
  }
  console.error('Resolve these by hand before running the migration.');
  return true;
}

async function main(): Promise<void> {
  await connectDb();

  if (DRY) say('nothing will be written');

  // Must come first: everything below writes duplicates.
  await dropUniqueIndex();

  // Trashed accounts are included deliberately. They are part of the customer's
  // history, a restore must not resurrect an orphan number, and the oldest
  // account is the oldest whether or not somebody deleted it.
  const accounts = (await SusuAccountModel.find(
    {},
    { customerId: 1, accountNumber: 1, issuedNumber: 1, cycleMonth: 1, createdAt: 1 },
  )
    .sort({ createdAt: 1, _id: 1 })
    .lean()) as unknown as AccountRow[];

  const families = new Map<string, AccountRow[]>();
  for (const row of accounts) {
    const key = row.customerId.toHexString();
    const family = families.get(key);
    if (family) family.push(row);
    else families.set(key, [row]);
  }

  // Stems first, so a collision is reported before a single write lands.
  const stems = new Map<string, string[]>();
  for (const family of families.values()) {
    const oldest = family[0];
    if (!oldest) continue;
    const stem = bareAccountNumber(oldest.issuedNumber ?? oldest.accountNumber);
    const owners = stems.get(stem);
    if (owners) owners.push(oldest.customerId.toHexString());
    else stems.set(stem, [oldest.customerId.toHexString()]);
  }
  if (reportStemCollisions(stems)) {
    await disconnectDb();
    process.exitCode = 1;
    return;
  }

  let claimed = 0;
  let rewritten = 0;
  let untouched = 0;
  const samples: string[] = [];

  for (const family of families.values()) {
    const oldest = family[0];
    if (!oldest) continue;
    // The oldest account's own number is the stem — its original one where the
    // migration has already touched it, so re-running cannot drift.
    const stem = bareAccountNumber(oldest.issuedNumber ?? oldest.accountNumber);

    if (DRY) {
      const held = await CustomerModel.findById(oldest.customerId, { susuNumber: 1 });
      if (!held?.susuNumber) claimed += 1;
    } else {
      const claim = await CustomerModel.updateOne(
        { _id: oldest.customerId, susuNumber: null },
        { $set: { susuNumber: stem } },
      );
      if (claim.modifiedCount === 1) claimed += 1;
    }

    for (const account of family) {
      // Each book keeps the month it is called by. An account from before the
      // suffix existed has none and gets none — inventing one would print a
      // month the customer never agreed to.
      const month = account.cycleMonth ?? cycleMonthFrom(account.accountNumber);
      const target = withCycleMonth(stem, month);
      if (target === account.accountNumber) {
        untouched += 1;
        continue;
      }
      if (samples.length < 10) {
        samples.push(`  ${account.accountNumber} -> ${target}  (kept as issuedNumber)`);
      }
      if (!DRY) {
        await SusuAccountModel.updateOne(
          { _id: account._id },
          {
            $set: {
              accountNumber: target,
              // Only ever set once: on a re-run the branch above has already
              // matched, so this cannot overwrite a genuine original.
              ...(account.issuedNumber === undefined
                ? { issuedNumber: account.accountNumber }
                : {}),
            },
          },
        );
      }
      rewritten += 1;
    }
  }

  say(
    `customers: ${String(families.size)} (${String(claimed)} numbers ${DRY ? 'to claim' : 'claimed'}) · ` +
      `accounts: ${String(rewritten)} ${DRY ? 'to rewrite' : 'rewritten'}, ` +
      `${String(untouched)} already correct`,
  );
  if (samples.length > 0) {
    say(`first ${String(samples.length)}:`);
    for (const line of samples) console.log(line);
  }

  if (DRY) {
    say('done — nothing was written');
    await disconnectDb();
    return;
  }

  // Rebuilds the non-unique accountNumber index, the sparse issuedNumber index
  // and the customer's unique sparse susuNumber index from the schemas.
  await Promise.all([SusuAccountModel.syncIndexes(), CustomerModel.syncIndexes()]);
  console.log('indexes synced');

  await disconnectDb();
}

await main();
