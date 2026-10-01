/**
 * Merge each customer's per-cycle susu "books" into their ONE account with
 * plans inside it (client decision, 30 Sep 2026).
 *
 *   npx tsx src/scripts/migrate-susu-plans.ts            # dry run: reports, writes nothing
 *   npx tsx src/scripts/migrate-susu-plans.ts --apply    # writes
 *
 * What it does, per customer:
 *   - keeps their OLDEST book as the account, renumbered to the customer's
 *     bare susu number (no cycle-month suffix);
 *   - turns every book into a plan on that account, keeping its count: an
 *     active book is a plan mid-cycle, a completed one a plan between cycles
 *     with one cycle done, a closed / terminated / pending-payout one a
 *     stopped plan with its cycle on the books;
 *   - re-points every deposit, payout, repayment, transfer, charge, correction
 *     and payout request at the kept account, and rewrites deposits into the
 *     new line shape;
 *   - sets the balance to what the books held: what open books held, plus
 *     anything still awaiting payout. A COMPLETED book's commission — due on
 *     its 31st payment under the new rule, and about to be taken at closure
 *     under the old — is taken here, so its plan starts its next cycle square.
 *
 * Idempotent: a book already in the new shape (it has `balance` and no
 * `dailyAmount`) is left alone. Refuses to run against anything but a local
 * host unless --allow-remote is given: this rewrites the susu ledger.
 */
import mongoose, { Types } from 'mongoose';
import { connectDb, disconnectDb } from '../lib/db.js';
import { env } from '../config/env.js';
import {
  CustomerModel,
  PaystackChargeModel,
  PayoutRequestModel,
  RepaymentModel,
  SusuAccountModel,
  SusuCycleModel,
  SusuDepositModel,
  SusuPayoutModel,
  SusuPlanModel,
  TransferModel,
  TxnCorrectionModel,
} from '../models/index.js';
import { SUSU_CYCLE_PAYMENTS, allocateWithdrawal } from '../domain/susu-plans.js';
import { orderPlans, planMoney } from '../modules/susu/susu.service.js';

const APPLY = process.argv.includes('--apply');
const ALLOW_REMOTE = process.argv.includes('--allow-remote');

/** An old-shape book, read raw — the model no longer describes these fields. */
interface OldBook {
  _id: Types.ObjectId;
  accountNumber: string;
  issuedNumber?: string;
  customerId: Types.ObjectId;
  dailyAmount: number;
  depositsCount: number;
  totalDeposited: number;
  withdrawnAmount?: number;
  status: 'active' | 'completed' | 'pending-payout' | 'closed' | 'terminated';
  openedById: Types.ObjectId;
  closedById?: Types.ObjectId;
  closedAt?: Date;
  commissionAmount?: number;
  payoutRemaining?: number;
  createdAt: Date;
  deletedAt?: Date | null;
  /** Present only on a book already migrated. */
  balance?: number;
}

interface OldDeposit {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  amount: number;
  daysCovered: number;
  seqStart: number;
  seqEnd: number;
  createdAt: Date;
}

function bare(number: string): string {
  const cut = number.indexOf('-');
  return cut === -1 ? number : number.slice(0, cut);
}

interface Summary {
  customers: number;
  books: number;
  plans: number;
  deposits: number;
  /** Payouts given their plan's line as their book became a plan. */
  payoutsLabelled: number;
  balanceBefore: number;
  balanceAfter: number;
  commissionTakenNow: number;
}

export async function migrateSusuPlans(apply: boolean): Promise<Summary> {
  const summary: Summary = {
    customers: 0,
    books: 0,
    plans: 0,
    deposits: 0,
    payoutsLabelled: 0,
    balanceBefore: 0,
    balanceAfter: 0,
    commissionTakenNow: 0,
  };
  const accounts = SusuAccountModel.collection;
  const deposits = SusuDepositModel.collection;

  // Only books in the old shape. Trashed books were never used, and the
  // trash cannot hold a per-cycle book any more: they are dropped.
  const trashed = await accounts.countDocuments({
    dailyAmount: { $exists: true },
    deletedAt: { $ne: null },
  });
  if (trashed > 0) {
    console.log(`${String(trashed)} trashed old book(s) will be deleted`);
    if (apply)
      await accounts.deleteMany({ dailyAmount: { $exists: true }, deletedAt: { $ne: null } });
  }

  const books = (await accounts
    .find({ dailyAmount: { $exists: true }, deletedAt: null })
    .sort({ customerId: 1, createdAt: 1, _id: 1 })
    .toArray()) as unknown as OldBook[];

  const byCustomer = new Map<string, OldBook[]>();
  for (const b of books) {
    const key = b.customerId.toHexString();
    const list = byCustomer.get(key);
    if (list) list.push(b);
    else byCustomer.set(key, [b]);
  }

  for (const [customerHex, list] of byCustomer) {
    const customerId = new Types.ObjectId(customerHex);
    const keep = list[0];
    if (!keep) continue;
    summary.customers += 1;
    summary.books += list.length;

    const customer = await CustomerModel.findById(customerId, { susuNumber: 1 });
    const number = customer?.susuNumber ?? bare(keep.issuedNumber ?? keep.accountNumber);

    let balance = 0;
    let anyOpen = false;
    let latestClosedAt: Date | undefined;
    const planDocs: Record<string, unknown>[] = [];
    const cycleDocs: Record<string, unknown>[] = [];
    const depositWrites: { id: Types.ObjectId; set: Record<string, unknown> }[] = [];
    // Each book's payouts — withdrawals and its closing payout — were that
    // book's alone, so they become that plan's lines: exact attribution,
    // costing no days (the book's count already stood where it stood).
    const payoutLines: { bookId: Types.ObjectId; planId: Types.ObjectId; dailyAmount: number }[] =
      [];

    for (const book of list) {
      const planId = new Types.ObjectId();
      payoutLines.push({ bookId: book._id, planId, dailyAmount: book.dailyAmount });
      const withdrawn = book.withdrawnAmount ?? 0;
      const held = book.totalDeposited - withdrawn;
      const completedCycle = book.depositsCount >= SUSU_CYCLE_PAYMENTS;
      const open = book.status === 'active' || book.status === 'completed';
      const owed = book.status === 'pending-payout' ? (book.payoutRemaining ?? 0) : 0;
      summary.balanceBefore += open ? held : owed;

      // Commission a completed-but-open book still owes under the new rule.
      const commissionNow =
        book.status === 'completed' && completedCycle ? Math.min(held, book.dailyAmount) : 0;
      summary.commissionTakenNow += commissionNow;

      const stopped = !open;
      const lastDeposit = (await deposits
        .find({ accountId: book._id, deletedAt: null })
        .sort({ createdAt: -1, _id: -1 })
        .limit(1)
        .toArray()) as unknown as OldDeposit[];
      const endedAt = book.closedAt ?? lastDeposit[0]?.createdAt ?? book.createdAt;

      planDocs.push({
        _id: planId,
        accountId: keep._id,
        customerId,
        dailyAmount: book.dailyAmount,
        paidInCycle: open && !completedCycle ? book.depositsCount : 0,
        cyclesCompleted: completedCycle ? 1 : 0,
        status: stopped ? 'stopped' : 'active',
        startedById: book.openedById,
        ...(stopped
          ? {
              stoppedAt: endedAt,
              ...(book.closedById ? { stoppedById: book.closedById } : {}),
              stopCommission: book.commissionAmount ?? 0,
            }
          : {}),
        createdAt: book.createdAt,
        updatedAt: new Date(),
      });
      summary.plans += 1;

      // The cycle this book ran, once it has ended one way or another. A
      // stopped book's commission already sits on its closing payout row, so
      // its cycle is filed as 'account-closed' — the one reason the ledger
      // feed does not read commission from, or it would count twice.
      if ((completedCycle || stopped) && book.depositsCount > 0) {
        cycleDocs.push({
          planId,
          accountId: keep._id,
          customerId,
          cycleNumber: 1,
          dailyAmount: book.dailyAmount,
          payments: Math.min(SUSU_CYCLE_PAYMENTS, book.depositsCount),
          commissionAmount: stopped ? (book.commissionAmount ?? 0) : commissionNow,
          endReason: completedCycle ? 'completed' : 'account-closed',
          endedAt,
          ...(stopped && book.closedById ? { endedById: book.closedById } : {}),
        });
      }

      // Deposits: one line each, on this plan's first cycle. The 31st payment
      // of a still-open completed book carries the commission taken here.
      const rows = (await deposits
        .find({ accountId: book._id })
        .toArray()) as unknown as OldDeposit[];
      for (const d of rows) {
        const commission =
          d.seqEnd === SUSU_CYCLE_PAYMENTS && book.status === 'completed' ? commissionNow : 0;
        depositWrites.push({
          id: d._id,
          set: {
            accountId: keep._id,
            lines: [
              {
                planId,
                dailyAmount: book.dailyAmount,
                cycleNumber: 1,
                payments: d.daysCovered,
                seqStart: d.seqStart,
                seqEnd: d.seqEnd,
                amount: d.amount,
                commissionAmount: commission,
              },
            ],
            leftover: 0,
            commissionAmount: commission,
          },
        });
        summary.deposits += 1;
      }

      if (open) {
        anyOpen = true;
        balance += held - commissionNow;
      } else if (owed > 0) {
        anyOpen = true;
        balance += owed;
      }
      if (book.closedAt && (!latestClosedAt || book.closedAt > latestClosedAt)) {
        latestClosedAt = book.closedAt;
      }
    }

    summary.balanceAfter += balance;
    const status = anyOpen || balance > 0 ? 'active' : 'closed';
    console.log(
      `${customerHex}: ${String(list.length)} book(s) -> ${number}, balance ${String(balance)}, ${status}`,
    );
    if (!apply) continue;

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const others = list.filter((b) => !b._id.equals(keep._id)).map((b) => b._id);
        await SusuPlanModel.collection.insertMany(planDocs, { session });
        if (cycleDocs.length > 0)
          await SusuCycleModel.collection.insertMany(cycleDocs, { session });
        for (const w of depositWrites) {
          await deposits.updateOne(
            { _id: w.id },
            {
              $set: w.set,
              $unset: {
                daysCovered: '',
                seqStart: '',
                seqEnd: '',
                collectAllBatchId: '',
                carriedToDepositId: '',
                carriedToAccountId: '',
                carriedFromDepositId: '',
                carriedFromAccountId: '',
              },
            },
            { session },
          );
        }
        const all = [keep._id, ...others];
        for (const pl of payoutLines) {
          const r = await SusuPayoutModel.collection.updateMany(
            { accountId: pl.bookId, lines: { $exists: false } },
            [
              {
                $set: {
                  lines: [
                    {
                      planId: pl.planId,
                      dailyAmount: pl.dailyAmount,
                      amount: '$amount',
                      paymentsRemoved: 0,
                    },
                  ],
                },
              },
            ],
            { session },
          );
          summary.payoutsLabelled += r.modifiedCount;
        }
        await SusuPayoutModel.collection.updateMany(
          { accountId: { $in: all } },
          [
            {
              $set: {
                accountId: keep._id,
                kind: { $cond: [{ $eq: ['$kind', 'partial-withdrawal'] }, 'withdrawal', '$kind'] },
              },
            },
          ],
          { session },
        );
        if (others.length > 0) {
          await RepaymentModel.collection.updateMany(
            { susuAccountId: { $in: others } },
            { $set: { susuAccountId: keep._id } },
            { session },
          );
          await PayoutRequestModel.collection.updateMany(
            { targetId: { $in: others } },
            { $set: { targetId: keep._id } },
            { session },
          );
          await PaystackChargeModel.collection.updateMany(
            { targetId: { $in: others }, kind: 'susu-deposit' },
            { $set: { targetId: keep._id } },
            { session },
          );
          await TxnCorrectionModel.collection.updateMany(
            { targetId: { $in: others }, kind: 'susu-deposit' },
            { $set: { targetId: keep._id } },
            { session },
          );
          await TransferModel.collection.updateMany(
            { fromType: 'susu', fromId: { $in: others } },
            { $set: { fromId: keep._id } },
            { session },
          );
          await TransferModel.collection.updateMany(
            { toType: 'susu', toId: { $in: others } },
            { $set: { toId: keep._id } },
            { session },
          );
          await accounts.deleteMany({ _id: { $in: others } }, { session });
        }
        await accounts.updateOne(
          { _id: keep._id },
          {
            $set: {
              accountNumber: number,
              balance,
              status,
              ...(status === 'closed' && latestClosedAt ? { closedAt: latestClosedAt } : {}),
            },
            $unset: {
              issuedNumber: '',
              cycleMonth: '',
              dailyAmount: '',
              depositsCount: '',
              totalDeposited: '',
              withdrawnAmount: '',
              carriedFromAccountId: '',
              commissionAmount: '',
              payoutAmount: '',
              payoutRemaining: '',
              ...(status === 'active' ? { closedAt: '', closedById: '' } : {}),
            },
          },
          { session },
        );
        await CustomerModel.collection.updateOne(
          { _id: customerId },
          { $set: { susuNumber: number } },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
  }

  if (apply) {
    // Old indexes (the non-unique accountNumber, issuedNumber) go; the new
    // unique ones come in.
    await Promise.all([
      SusuAccountModel.syncIndexes(),
      SusuDepositModel.syncIndexes(),
      SusuPlanModel.syncIndexes(),
      SusuCycleModel.syncIndexes(),
      SusuPayoutModel.syncIndexes(),
    ]);
  }
  return summary;
}

interface BackfillSummary {
  accounts: number;
  /** Withdrawals given lines by walking the plans. */
  payouts: number;
  /** Money those withdrawals took that no plan could be found for. */
  loose: number;
}

/**
 * Money out that names no plan — withdrawals made on an already-migrated
 * account before withdrawals recorded their shares (30 Sep 2026) — gets its
 * shares now, the way a live withdrawal would: oldest first, walking the
 * plans (running first, oldest first), each giving what it holds less its
 * lock, costing no days (those withdrawals left the cycles alone when they
 * happened). Afterwards the plans' balances add up to the account's, less
 * whatever was genuinely loose. Idempotent: a payout with lines is skipped.
 */
export async function backfillPayoutLines(apply: boolean): Promise<BackfillSummary> {
  const summary: BackfillSummary = { accounts: 0, payouts: 0, loose: 0 };
  const unlabelled = await SusuPayoutModel.aggregate<{ _id: Types.ObjectId }>([
    { $match: { kind: { $in: ['withdrawal', 'payout'] }, lines: { $exists: false } } },
    { $group: { _id: '$accountId' } },
  ]);
  for (const { _id: accountId } of unlabelled) {
    const plans = await SusuPlanModel.find({ accountId }).sort({ createdAt: 1, _id: 1 });
    if (plans.length === 0) continue; // an old-shape book: the migration proper handles it
    summary.accounts += 1;
    const money = await planMoney(accountId, plans);
    const ordered = orderPlans(plans);
    const balances = new Map(
      ordered.map((p) => [p._id.toHexString(), money.get(p._id.toHexString())?.balance ?? 0]),
    );
    const payouts = await SusuPayoutModel.find({
      accountId,
      kind: { $in: ['withdrawal', 'payout'] },
      lines: { $exists: false },
    }).sort({ createdAt: 1, _id: 1 });
    for (const payout of payouts) {
      const allocation = allocateWithdrawal(
        ordered.map((p) => ({
          planId: p._id.toHexString(),
          dailyAmount: p.dailyAmount,
          paidInCycle: p.paidInCycle,
          cyclesCompleted: p.cyclesCompleted,
          status: p.status,
          balance: balances.get(p._id.toHexString()) ?? 0,
        })),
        payout.amount,
        false,
      );
      for (const l of allocation.lines) {
        balances.set(l.planId, (balances.get(l.planId) ?? 0) - l.amount);
      }
      summary.loose += allocation.loose;
      if (allocation.lines.length === 0) continue;
      summary.payouts += 1;
      console.log(
        `${accountId.toHexString()}: payout ${payout._id.toHexString()} ${String(payout.amount)} -> ` +
          allocation.lines.map((l) => `${l.planId.slice(-6)}:${String(l.amount)}`).join(', ') +
          (allocation.loose > 0 ? ` (+${String(allocation.loose)} loose)` : ''),
      );
      if (!apply) continue;
      await SusuPayoutModel.updateOne(
        { _id: payout._id, lines: { $exists: false } },
        {
          $set: {
            lines: allocation.lines.map((l) => ({
              planId: new Types.ObjectId(l.planId),
              dailyAmount: l.dailyAmount,
              amount: l.amount,
              paymentsRemoved: 0,
            })),
          },
        },
      );
    }
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
  const summary = await migrateSusuPlans(APPLY);
  console.log(summary);
  const drift = summary.balanceBefore - summary.commissionTakenNow - summary.balanceAfter;
  console.log(
    drift === 0 ? 'Money reconciles.' : `MONEY DOES NOT RECONCILE: drift ${String(drift)}`,
  );
  console.log('Backfilling plan shares on unlabelled withdrawals…');
  console.log(await backfillPayoutLines(APPLY));
  await disconnectDb();
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('migrate-susu-plans.ts');
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
